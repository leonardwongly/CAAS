import airportNameBundle from "./data/airport-names.json" with { type: "json" };

type AirportNameRecord = { icao: string; name: string };
type AirportNameBundle = { schemaVersion: number; records: AirportNameRecord[] };

const parsed = airportNameBundle as AirportNameBundle;
if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
  throw new Error("The bundled airport-name reference has an unsupported schema.");
}

const names = new Map<string, string>();
for (const record of parsed.records) {
  if (!/^[A-Z]{4}$/.test(record.icao) || !record.name.trim() || record.name.length > 160) {
    throw new Error("The bundled airport-name reference contains an invalid record.");
  }
  if (names.has(record.icao)) throw new Error(`The bundled airport-name reference contains duplicate ICAO code ${record.icao}.`);
  names.set(record.icao, record.name.normalize("NFC"));
}

export function airportNameForIcao(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{4}$/.test(normalized) ? names.get(normalized) : undefined;
}

export function airportDisplayLabel(icao: string, suppliedName?: string): string {
  const code = icao.trim().toUpperCase();
  const name = suppliedName?.trim() || airportNameForIcao(code);
  return `${name ?? "Name unavailable"} (${code})`;
}

export const AIRPORT_NAME_RECORD_COUNT = names.size;
