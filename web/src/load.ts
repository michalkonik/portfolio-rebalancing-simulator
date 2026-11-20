import { parseCandleCsv } from "@engine/csv.ts";
import type { CandleSeries } from "@engine/types.ts";

const memory = new Map<string, Promise<CandleSeries>>();

export async function loadCandles(url: string, symbol: string): Promise<CandleSeries> {
  const cached = memory.get(url);
  if (cached) return cached;
  const pending = fetchCandles(url, symbol);
  memory.set(url, pending);
  try {
    return await pending;
  } catch (error) {
    memory.delete(url);
    throw error;
  }
}

async function fetchCandles(url: string, symbol: string): Promise<CandleSeries> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${symbol} (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let text: string;
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const series = parseCandleCsv(text, symbol);
  if (series.t.length < 2) throw new Error(`${symbol} did not contain enough candles.`);
  return series;
}
