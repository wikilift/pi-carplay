// globals provided by AudioWorklet
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: any): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: any)
}

const RENDER_QUANTUM_FRAMES = 128
const RING_POINTERS_SIZE = 8

// Helpers
function quantaFromMs(ms: number, sr: number) {
  return Math.max(1, Math.ceil((ms / 1000) * sr / RENDER_QUANTUM_FRAMES))
}

class RingBuffReader {
  private storage: Int16Array
  private writePointer: Uint32Array
  private readPointer: Uint32Array

  constructor(buffer: SharedArrayBuffer) {
    const storageSize =
      (buffer.byteLength - RING_POINTERS_SIZE) / Int16Array.BYTES_PER_ELEMENT
    this.storage = new Int16Array(buffer, RING_POINTERS_SIZE, storageSize)
    this.writePointer = new Uint32Array(buffer, 0, 1)
    this.readPointer = new Uint32Array(buffer, 4, 1)
  }

  readTo(target: Int16Array): number {
    const { readPos, available } = this.getReadInfo()
    if (available === 0) return 0

    const readLength = Math.min(available, target.length)
    const first = Math.min(this.storage.length - readPos, readLength)
    const second = readLength - first

    target.set(this.storage.subarray(readPos, readPos + first), 0)
    if (second > 0) target.set(this.storage.subarray(0, second), first)

    Atomics.store(this.readPointer, 0, (readPos + readLength) % this.storage.length)
    return readLength
  }

  getReadInfo() {
    const readPos = Atomics.load(this.readPointer, 0)
    const writePos = Atomics.load(this.writePointer, 0)
    const available = (writePos + this.storage.length - readPos) % this.storage.length
    return { readPos, writePos, available }
  }
}

class PCMWorkletProcessor extends AudioWorkletProcessor {
  private channels: number
  private reader: RingBuffReader
  private readerOutput: Int16Array

  // Priming / preroll
  private streamSR = sampleRate
  private basePrerollQ: number
  private targetPrerollQ: number
  private maxPrerollQ: number

  private primed = false
  private stableBlocks = 0
  private softUnderruns = 0
  private hardUnderruns = 0

  // Ramp
  private rampMs = 8
  private rampLen = 0
  private rampLeft = 0
  private needRamp = true
  private xfFromL = 0
  private xfFromR = 0
  private xfFromM = 0

  // Last samples for clickless padding
  private lastL = 0
  private lastR = 0
  private lastM = 0

  private reportedUnderrun = false

  constructor(options: any) {
    super()
    const { sab, channels, streamSampleRate, prerollMs, maxPrerollMs, rampMs } =
      (options?.processorOptions as {
        sab: SharedArrayBuffer
        channels: number
        streamSampleRate?: number
        prerollMs?: number      // default ~8ms
        maxPrerollMs?: number   // default ~40ms
        rampMs?: number         // default ~5ms
      }) || {}

    this.channels = Math.max(1, channels | 0 || 1)
    this.reader = new RingBuffReader(sab)
    this.readerOutput = new Int16Array(RENDER_QUANTUM_FRAMES * this.channels)

    if (typeof streamSampleRate === 'number' && streamSampleRate > 0) this.streamSR = streamSampleRate
    if (typeof rampMs === 'number' && rampMs >= 0) this.rampMs = rampMs

    const baseMs = typeof prerollMs === 'number' && prerollMs > 0 ? prerollMs : 8   // ~3 quanta @48k
    const maxMs  = typeof maxPrerollMs === 'number' && maxPrerollMs > baseMs ? maxPrerollMs : 40

    this.basePrerollQ   = quantaFromMs(baseMs, this.streamSR)
    this.targetPrerollQ = this.basePrerollQ
    this.maxPrerollQ    = quantaFromMs(maxMs,  this.streamSR)

    // Optional runtime tuning
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data || {}
      if (msg.t === 'setPrerollMs' && typeof msg.ms === 'number' && msg.ms > 0) {
        this.basePrerollQ = quantaFromMs(msg.ms, this.streamSR)
        this.targetPrerollQ = Math.max(this.targetPrerollQ, this.basePrerollQ)
      } else if (msg.t === 'setRampMs' && typeof msg.ms === 'number' && msg.ms >= 0) {
        this.rampMs = msg.ms
        this.needRamp = true
        this.rampLeft = 0
      }
    }
  }

  private toF32(s16: number) { return s16 / 32768 }

  private beginRamp() {
    this.rampLen = Math.max(1, Math.floor((this.streamSR * this.rampMs) / 1000))
    this.rampLeft = this.rampLen
    this.xfFromL = this.lastL
    this.xfFromR = this.lastR
    this.xfFromM = this.lastM
    this.needRamp = false
  }

  private fillWithLast(out: Float32Array[], frames: number) {
    if (out.length >= 2 && this.channels === 2) {
      const L = out[0], R = out[1] ?? out[0]
      for (let f = 0; f < frames; f++) { L[f] = this.lastL; R[f] = this.lastR }
      for (let c = 2; c < out.length; c++) out[c].fill(0)
    } else {
      const M = out[0]
      for (let f = 0; f < frames; f++) M[f] = this.lastM
      for (let c = 1; c < out.length; c++) out[c].fill(this.lastM)
    }
  }

  private applyRampStereo(L: Float32Array, R: Float32Array, written: number) {
    const start = this.rampLen - this.rampLeft
    const n = Math.min(written, this.rampLeft)
    for (let k = 0; k < n; k++) {
      const a = (start + k + 1) / this.rampLen, b = 1 - a
      L[k] = b * this.xfFromL + a * L[k]
      R[k] = b * this.xfFromR + a * R[k]
    }
    this.rampLeft -= n
    if (this.rampLeft < 0) this.rampLeft = 0
  }

  private applyRampMono(M: Float32Array, written: number) {
    const start = this.rampLen - this.rampLeft
    const n = Math.min(written, this.rampLeft)
    for (let k = 0; k < n; k++) {
      const a = (start + k + 1) / this.rampLen, b = 1 - a
      M[k] = b * this.xfFromM + a * M[k]
    }
    this.rampLeft -= n
    if (this.rampLeft < 0) this.rampLeft = 0
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const ch = this.channels
    const frames = RENDER_QUANTUM_FRAMES
    const needSamples = frames * ch

    let info = this.reader.getReadInfo()

    // Priming with small, adaptive preroll
    if (!this.primed) {
      if (info.available >= this.targetPrerollQ * needSamples) {
        this.primed = true
        this.needRamp = true
        this.stableBlocks = 0
        this.softUnderruns = 0
        this.hardUnderruns = 0
      } else {
        for (let c = 0; c < out.length; c++) out[c].fill(0)
        return true
      }
    }

    // Channel-aligned
    const want = Math.min(this.readerOutput.length, info.available)
    const aligned = want - (want % ch)

    if (aligned === 0) {
      this.fillWithLast(out, frames)
      this.needRamp = true
      this.primed = false
      this.hardUnderruns++
      if (this.targetPrerollQ < this.maxPrerollQ) this.targetPrerollQ += 1
      this.stableBlocks = 0
      this.softUnderruns = 0
      if (!this.reportedUnderrun) { this.port.postMessage({ t: 'underrun' }); this.reportedUnderrun = true }
      return true
    }

    const got = this.reader.readTo(this.readerOutput.subarray(0, aligned))
    const framesGot = (got / ch) | 0

    if (this.needRamp && this.rampLeft === 0) this.beginRamp()

    if (ch === 2) {
      const L = out[0], R = out[1] ?? out[0]
      let f = 0, i = 0
      for (; f < framesGot; f++, i += 2) {
        L[f] = this.toF32(this.readerOutput[i])
        R[f] = this.toF32(this.readerOutput[i + 1])
      }
      if (this.rampLeft > 0) this.applyRampStereo(L, R, f)
      const padL = f ? L[f - 1] : this.lastL
      const padR = f ? R[f - 1] : this.lastR
      for (; f < frames; f++) { L[f] = padL; R[f] = padR }
      for (let c = 2; c < out.length; c++) out[c].fill(0)
      this.lastL = L[frames - 1]
      this.lastR = R[frames - 1]
    } else {
      const M = out[0]
      let f = 0
      for (; f < framesGot; f++) M[f] = this.toF32(this.readerOutput[f])
      if (this.rampLeft > 0) this.applyRampMono(M, f)
      const pad = f ? M[f - 1] : this.lastM
      for (; f < frames; f++) M[f] = pad
      for (let c = 1; c < out.length; c++) out[c].fill(0)
      this.lastM = M[frames - 1]
    }

    if (framesGot === frames) {
      this.stableBlocks++
      if (this.stableBlocks >= 128 && this.targetPrerollQ > this.basePrerollQ) {
        this.targetPrerollQ -= 1
        this.stableBlocks = 0
      }
      this.softUnderruns = 0
      if (this.reportedUnderrun) { this.port.postMessage({ t: 'recovered' }); this.reportedUnderrun = false }
    } else {
      this.needRamp = true
      this.stableBlocks = 0
      this.softUnderruns++
      if (this.softUnderruns >= 4 && this.targetPrerollQ < this.maxPrerollQ) {
        this.targetPrerollQ += 1
        this.softUnderruns = 0
      }
    }

    return true
  }
}

registerProcessor('pcm-worklet-processor', PCMWorkletProcessor)
