// Deterministic merchant-unit normalisation. Pure and side-effect free so it
// can be shared by client and server code.
//
// IMPORTANT: normalising a unit is a *labelling* operation only. It must NEVER
// change quantity, unit price or any financial total — callers only ever use
// the returned `normalised` string as an additional, canonical label alongside
// the preserved raw merchant unit.

// Conservative, high-confidence mappings from common UK builders'-merchant unit
// codes to a canonical Gilbert OS unit. Only add entries whose meaning is
// unambiguous across merchants. Anything not present here is left un-normalised
// (the enrichment pass may still propose one, flagged for review).
const UNIT_MAP: Record<string, string> = {
  // each / number
  ea: "each",
  each: "each",
  eah: "each",
  no: "each",
  nr: "each",
  num: "each",
  unit: "each",
  pc: "each",
  pcs: "each",
  piece: "each",
  // sheet / board
  sh: "sheet",
  sht: "sheet",
  sheet: "sheet",
  sheets: "sheet",
  bd: "board",
  // length
  m: "metre",
  mtr: "metre",
  mtrs: "metre",
  metre: "metre",
  metres: "metre",
  meter: "metre",
  lm: "linear metre",
  lin: "linear metre",
  mm: "millimetre",
  // area / volume
  m2: "square metre",
  sqm: "square metre",
  sm: "square metre",
  m3: "cubic metre",
  cum: "cubic metre",
  // packaging
  bg: "bag",
  bag: "bag",
  bags: "bag",
  box: "box",
  bx: "box",
  boxes: "box",
  pk: "pack",
  pack: "pack",
  pkt: "pack",
  packet: "pack",
  roll: "roll",
  rl: "roll",
  rolls: "roll",
  tub: "tub",
  tube: "tube",
  drum: "drum",
  can: "can",
  ctn: "carton",
  carton: "carton",
  pallet: "pallet",
  plt: "pallet",
  bundle: "bundle",
  bdl: "bundle",
  // weight
  kg: "kilogram",
  kgs: "kilogram",
  g: "gram",
  t: "tonne",
  te: "tonne",
  ton: "tonne",
  tonne: "tonne",
  // liquid
  l: "litre",
  ltr: "litre",
  ltrs: "litre",
  litre: "litre",
  ml: "millilitre",
  // time / service
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  day: "day",
  wk: "week",
  week: "week",
}

export type UnitNormalisation = {
  raw: string | null
  /** Canonical unit, or null when we are not confident. */
  normalised: string | null
  /** true when a confident deterministic mapping was found. */
  matched: boolean
}

/** Normalise a raw merchant unit into a canonical Gilbert OS unit. */
export function normaliseUnit(raw: string | null | undefined): UnitNormalisation {
  const trimmed = (raw ?? "").trim()
  if (!trimmed) return { raw: null, normalised: null, matched: false }
  const key = trimmed.toLowerCase().replace(/[.\s]/g, "")
  const mapped = UNIT_MAP[key] ?? null
  return { raw: trimmed, normalised: mapped, matched: Boolean(mapped) }
}
