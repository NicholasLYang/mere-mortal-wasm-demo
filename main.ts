function encodePreamble() {
  return [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
}

enum NumType {
  i32 = 0x7f,
  i64 = 0x7e,
  f32 = 0x7d,
  f64 = 0x7c,
}

enum RefType {
  funcRef = 0x70,
  externRef = 0x6f,
}

type ValueType = RefType | NumType;

function encodeLEB128U(
  n: number,
): number[] {
  if (!Number.isInteger(n)) {
    throw new RangeError(`n must be an integer, instead is ${n}`);
  }

  const buffer = [];
  // Loop until the next to last 7 bytes
  while (n > 0x7f) {
    buffer.push((n & 0x7f) | 0x80);
    n = n >> 7;
  }

  buffer.push(n);
  return buffer;
}

export function encodeLEB128S(
  n: number,
): number[] {
  if (!Number.isInteger(n)) {
    throw new RangeError(`n must be an integer, instead is ${n}`);
  }

  let buffer = [];
  n |= 0;
  while (true) {
    const byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
      buffer.push(byte);
      return buffer;
    }
    buffer.push(byte | 0x80);
  }
}

function encodeVector<T>(items: T[], encodeFn: (t: T) => number[]): number[] {
  return [
    ...encodeLEB128U(items.length),
    ...items.flatMap((item) => encodeFn(item)),
  ];
}

interface FuncType {
  paramTypes: ValueType[];
  returnTypes: ValueType[];
}

function encodeFuncType(funcType: FuncType) {
  return [
    0x60,
    ...encodeVector(funcType.paramTypes, (a) => [a]),
    ...encodeVector(funcType.returnTypes, (a) => [a]),
  ];
}

function encodeSection<T>(
  id: number,
  items: T[],
  encodeFn: (t: T) => number[],
) {
  const bytes = encodeVector(items, encodeFn);
  return [
    id,
    ...encodeLEB128U(bytes.length),
    ...bytes,
  ];
}

function encodeTypeSection(types: FuncType[]) {
  return encodeSection(1, types, encodeFuncType);
}

function encodeFuncSection(typeIndicies: number[]) {
  return encodeSection(3, typeIndicies, encodeLEB128U);
}

interface Limits {
  min: number;
  max?: number;
}

function encodeLimits(limits: Limits) {
  if (limits.max) {
    return [0x01, ...encodeLEB128U(limits.min), ...encodeLEB128U(limits.max)];
  } else {
    return [0x00, ...encodeLEB128U(limits.min)];
  }
}

function encodeMemorySection(memories: Limits[]) {
  return encodeSection(5, memories, encodeLimits);
}

enum ExportType {
  Function = 0,
  Table = 1,
  Memory = 2,
  Global = 3,
}

interface Export {
  name: string;
  type: ExportType;
  index: number;
}

function encodeExport(exportEntry: Export) {
  const nameBytes = (new TextEncoder()).encode(exportEntry.name);
  return [
    ...encodeLEB128U(nameBytes.length),
    ...nameBytes,
    exportEntry.type,
    ...encodeLEB128U(exportEntry.index),
  ];
}

function encodeExportSection(exports: Export[]) {
  return encodeSection(7, exports, encodeExport);
}

enum InstrType {
  If = 0x04,
  BrIf = 0x0d,
  Return = 0x0f,
  Call = 0x10,
  Drop = 0x1a,
  I32Load = 0x28,
  I32Const = 0x41,
  I32GtS = 0x4a,
  I32Eq = 0x46,
  I32Add = 0x6a,
  I32Mul = 0x6c,
  I32DivU = 0x6e,
  LocalGet = 0x20,
  LocalSet = 0x21,
  LocalTee = 0x22,
}

type Instruction =
  | [InstrType.I32Load, number, number]
  | [InstrType.I32Const, number]
  | [InstrType.I32GtS]
  | [InstrType.I32Eq]
  | [InstrType.I32Add]
  | [InstrType.I32Mul]
  | [InstrType.I32DivU]
  | [InstrType.LocalGet, number]
  | [InstrType.LocalSet, number]
  | [InstrType.LocalTee, number]
  | [InstrType.Drop]
  | [InstrType.BrIf, number]
  | [InstrType.Return]
  | [InstrType.Call, number]
  // Technically BlockType's include more than ValueType
  // but we're gonna ignore that for this
  | [InstrType.If, ValueType, Instruction[], Instruction[]];

interface FuncBody {
  locals: [number, ValueType][];
  instructions: Instruction[];
}

function encodeInstruction(instruction: Instruction): number[] {
  switch (instruction[0]) {
    case InstrType.I32Load:
      return [
        instruction[0],
        ...encodeLEB128U(instruction[1]),
        ...encodeLEB128U(instruction[2]),
      ];
    case InstrType.I32GtS:
    case InstrType.I32Eq:
    case InstrType.I32Add:
    case InstrType.I32Mul:
    case InstrType.I32DivU:
    case InstrType.Return:
    case InstrType.Drop:
      return [instruction[0]];
    case InstrType.I32Const:
      return [instruction[0], ...encodeLEB128S(instruction[1])];
    case InstrType.LocalGet:
    case InstrType.LocalSet:
    case InstrType.LocalTee:
    case InstrType.BrIf:
    case InstrType.Call:
      return [instruction[0], ...encodeLEB128U(instruction[1])];
    case InstrType.If:
      return [
        instruction[0],
        instruction[1],
        ...instruction[2].flatMap(encodeInstruction),
        0x05,
        ...instruction[3].flatMap(encodeInstruction),
        0x0b,
      ];
  }
}

function encodeFuncBody(body: FuncBody) {
  const encodedBody = [
    ...encodeVector(
      body.locals,
      ([count, type]) => [...encodeLEB128U(count), type],
    ),
    ...body.instructions.flatMap(encodeInstruction),
    0x0b, // end opcode
  ];
  return [...encodeLEB128U(encodedBody.length), ...encodedBody];
}

function encodeCodeSection(bodies: FuncBody[]) {
  return encodeSection(10, bodies, encodeFuncBody);
}

function tsBinarySearch(
    arr: number[],
    n: number,
    start: number,
    end: number,
): number {
  const mid = Math.floor((start + end) / 2);

  if (n == arr[mid]) {
    return mid;
  }

  if (mid == start) {
    return -1;
  }

  if (n > arr[mid]) {
    return tsBinarySearch(arr, n, mid, end);
  }

  return tsBinarySearch(arr, n, start, mid);
}

function encodeModule() {
  return new Uint8Array([
    ...encodePreamble(),
    ...encodeTypeSection([{
      // arr = local #0
      // n = local #1
      // start = local #2
      // end = local #3
      paramTypes: [NumType.i32, NumType.i32, NumType.i32, NumType.i32],
      // return index
      returnTypes: [NumType.i32],
    }]),
    ...encodeFuncSection([0]),
    ...encodeMemorySection([{ min: 1 }]),
    ...encodeExportSection([{
      name: "binarySearch",
      type: ExportType.Function,
      index: 0,
    }, { name: "memory", type: ExportType.Memory, index: 0 }]),
    ...encodeCodeSection([{
      locals: [[2, NumType.i32]],
      instructions: [
        [InstrType.LocalGet, 2],
        [InstrType.LocalGet, 3],
        [InstrType.I32Add],
        [InstrType.I32Const, 2],
        [InstrType.I32DivU],
        [InstrType.LocalTee, 4], // mid = (start + end)/2
        [InstrType.LocalGet, 4],
        [InstrType.LocalGet, 0],
        [InstrType.I32Add],
        [InstrType.I32Const, 4],
        [InstrType.I32Mul],
        [InstrType.I32Load, 0, 0],
        [InstrType.LocalTee, 5], // midElem = arr[mid]
        [InstrType.LocalGet, 1],
        [InstrType.I32Eq], // midElem == n
        [InstrType.BrIf, 0],
        [InstrType.Drop],
        [InstrType.I32Const, -1],
        [InstrType.LocalGet, 4],
        [InstrType.LocalGet, 2],
        [InstrType.I32Eq],
        [InstrType.BrIf, 0],
        [InstrType.Drop],
        [InstrType.LocalGet, 1], // n
        [InstrType.LocalGet, 5], // midElem
        [InstrType.I32GtS],
        [InstrType.If, NumType.i32, [
          [InstrType.LocalGet, 0],
          [InstrType.LocalGet, 1],
          [InstrType.LocalGet, 4],
          [
            InstrType.LocalGet,
            3,
          ],
          [InstrType.Call, 0],
        ], [
          [InstrType.LocalGet, 0],
          [InstrType.LocalGet, 1],
          [InstrType.LocalGet, 2],
          [InstrType.LocalGet, 4],
          [InstrType.Call, 0],
        ]],
      ],
    }]),
  ]);
}

const { instance } = await WebAssembly.instantiate(encodeModule());

function writeArrayToMemory(arr: number[], startIndex: number, memory: WebAssembly.Memory) {
  const buffer = new Uint32Array(memory.buffer);

  for (let i = 0; i < arr.length; i++) {
    buffer[startIndex + i] = arr[i];
  }
}
const { memory, binarySearch } = instance.exports;
writeArrayToMemory([-4, -2, 0, 2, 8, 13, 21, 54], 0, memory as WebAssembly.Memory);
// @ts-ignore
console.log(binarySearch(0, -20, 0, 7));

function wasmBinarySearch(arr: number[], n: number): number {
  writeArrayToMemory(arr, 0, memory as WebAssembly.Memory);
  // @ts-ignore
  return binarySearch(0, n, 0, arr.length - 1);
}

console.log(wasmBinarySearch([1, 2, 3, 4 ,5, 6, 7], 2));