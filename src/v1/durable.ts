// CLAIM(S33): file bytes, renamed entries, and newly created ancestors reach disk before callers publish or acknowledge [durability.test.ts].
import { mkdir as makeDirectory, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function mkdirDurably(path: string, _options?: { recursive: true }): Promise<void> {
  const directory = resolve(path);
  const created = await makeDirectory(directory, { recursive: true });
  if (created === undefined) return;
  const stop = dirname(created);
  for (let current = directory;; current = dirname(current)) {
    await syncDirectory(current);
    if (current === stop || current === dirname(current)) break;
  }
}
export async function writeDurably(path: string, text: string): Promise<void> {
  await mkdirDurably(dirname(path));
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
