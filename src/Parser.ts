import { parseRiff, Chunk, Options as RiffParserOptions } from "./RiffParser"
import { PresetHeader, SampleHeader, PresetBag, Instrument, InstrumentBag, ModulatorList, GeneratorList } from "./Structs"
import { readString } from "./readString"
import Stream from "./Stream"
import { InfoNameTable } from "./Constants"

export interface ParseResult {
  presetHeader: PresetHeader[]
  presetZone: PresetBag[]
  presetZoneModulator: ModulatorList[]
  presetZoneGenerator: ModulatorList[]
  instrument: Instrument[]
  instrumentZone: InstrumentBag[]
  instrumentZoneModulator: ModulatorList[]
  instrumentZoneGenerator: ModulatorList[]
  sampleHeader: SampleHeader[]
  sample: Int16Array[]
  samplingData: Chunk
  info: { [index: string]: string }
}

export default function parse(input: Uint8Array, option: RiffParserOptions = {}): ParseResult {

  // parse RIFF chunk
  const chunkList = parseRiff(input, 0, input.length, option)

  if (chunkList.length !== 1) {
    throw new Error('wrong chunk length')
  }

  const chunk = chunkList[0]
  if (chunk === null) {
    throw new Error('chunk not found')
  }

  function parseRiffChunk(chunk: Chunk, data: Uint8Array) {
    const chunkList = getChunkList(chunk, data, "RIFF", "sfbk")

    if (chunkList.length !== 3) {
      throw new Error('invalid sfbk structure')
    }

    return {
      // INFO-list
      info: parseInfoList(chunkList[0], data),

      // sdta-list
      samplingData: parseSdtaList(chunkList[1], data),

      // pdta-list
      ...parsePdtaList(chunkList[2], data)
    }
  }

  function parsePdtaList(chunk: Chunk, data: Uint8Array) {
    const chunkList = getChunkList(chunk, data, "LIST", "pdta")

    // check number of chunks
    if (chunkList.length !== 9) {
      throw new Error('invalid pdta chunk')
    }

    return {
      presetHeader: parsePhdr(chunkList[0], data),
      presetZone: parsePbag(chunkList[1], data),
      presetZoneModulator: parsePmod(chunkList[2], data),
      presetZoneGenerator: parsePgen(chunkList[3], data),
      instrument: parseInst(chunkList[4], data),
      instrumentZone: parseIbag(chunkList[5], data),
      instrumentZoneModulator: parseImod(chunkList[6], data),
      instrumentZoneGenerator: parseIgen(chunkList[7], data),
      sampleHeader: parseShdr(chunkList[8], data)
    }
  }

  const result = parseRiffChunk(chunk, input)

  return {
    ...result,
    sample: loadSample(result.sampleHeader, result.samplingData.offset, input)
  }
}

function getChunkList(chunk, data, expectedType, expectedSignature) {
  // check parse target
  if (chunk.type !== expectedType) {
    throw new Error('invalid chunk type:' + chunk.type)
  }

  const stream = new Stream(data, chunk.offset)

  // check signature
  const signature = stream.readString(4)
  if (signature !== expectedSignature) {
    throw new Error('invalid signature:' + signature)
  }

  // read structure
  return parseRiff(data, stream.ip, chunk.size - 4)
}

function parseInfoList(chunk: Chunk, data: Uint8Array) {
  const info: { [index: string]: string } = {}
  const chunkList = getChunkList(chunk, data, "LIST", "INFO")

  for (let p of chunkList) {
    const { offset, size, type } = p
    const name = InfoNameTable[type] || type
    info[name] = readString(data, offset, offset + size)
  }

  return info
}

function parseSdtaList(chunk: Chunk, data: Uint8Array): Chunk {
  const chunkList = getChunkList(chunk, data, "LIST", "sdta")

  if (chunkList.length !== 1) {
    throw new Error('TODO')
  }

  return chunkList[0]
}

function parseChunk<T>(chunk: Chunk, data: Uint8Array, type: string, factory: (Stream) => T): T[] {
  const result: T[] = []

  if (chunk.type !== type) {
    throw new Error('invalid chunk type:'  + chunk.type)
  }
  
  const stream = new Stream(data, chunk.offset)
  const size = chunk.offset + chunk.size
  
  while (stream.ip < size) {
    result.push(factory(stream))
  }

  return result
}

const parsePhdr = (chunk, data) => parseChunk(chunk, data, "phdr", stream => PresetHeader.parse(stream)).filter(p => p.presetName !== "EOP")
const parsePbag = (chunk, data) => parseChunk(chunk, data, "pbag", stream => PresetBag.parse(stream))
const parseInst = (chunk, data) => parseChunk(chunk, data, "inst", stream => Instrument.parse(stream)).filter(i => i.instrumentName !== "EOI")
const parseIbag = (chunk, data) => parseChunk(chunk, data, "ibag", stream => InstrumentBag.parse(stream))
const parsePmod = (chunk, data) => parseChunk(chunk, data, "pmod", stream => ModulatorList.parse(stream))
const parseImod = (chunk, data) => parseChunk(chunk, data, "imod", stream => ModulatorList.parse(stream))
const parsePgen = (chunk, data) => parseChunk(chunk, data, "pgen", stream => GeneratorList.parse(stream))
const parseIgen = (chunk, data) => parseChunk(chunk, data, "igen", stream => GeneratorList.parse(stream))
const parseShdr = (chunk, data) => parseChunk(chunk, data, "shdr", stream => SampleHeader.parse(stream)).filter(s => s.sampleName !== "EOS")

function adjustSampleData(sample, sampleRate) {
  let multiply = 1

  // buffer
  while (sampleRate < 22050) {
    const newSample = new Int16Array(sample.length * 2)
    for (let i = 0, j = 0, il = sample.length; i < il; ++i) {
      newSample[j++] = sample[i]
      newSample[j++] = sample[i]
    }
    sample = newSample
    multiply *= 2
    sampleRate *= 2
  }

  return {
    sample,
    multiply
  }
}

function loadSample(sampleHeader: SampleHeader[], samplingDataOffset: number, data: Uint8Array): Int16Array[] {
  return sampleHeader.map(header => {
    let sample = new Int16Array(new Uint8Array(data.subarray(
      samplingDataOffset + header.start * 2,
      samplingDataOffset + header.end   * 2
    )).buffer)
    if (header.sampleRate > 0) {
      const adjust = adjustSampleData(sample, header.sampleRate)
      sample = adjust.sample
      header.sampleRate *= adjust.multiply
      header.startLoop *= adjust.multiply
      header.endLoop *= adjust.multiply
    }
    return sample
  })
}