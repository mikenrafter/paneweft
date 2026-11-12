import type { ContainerMappingRecord } from "../models.ts";

/** `about:<index>:<cookieStoreId>:<backupName>`; the backup name may contain further colons. */
export function parseContainerMappingUrl(url: string): ContainerMappingRecord | undefined {
  const match = /^about:(\d+):([^:]+):(.+)$/.exec(url);
  if (match === null) return undefined;
  return { firstSeenIndex: Number(match[1]), cookieStoreId: match[2] as string, backupName: match[3] as string };
}

/** The rejected approach, kept for the dead-end example: splitting on every colon loses the rest of the name. */
export function naiveParse(url: string): ContainerMappingRecord | undefined {
  const parts = url.split(":");
  if (parts.length < 4) return undefined;
  return { firstSeenIndex: Number(parts[1]), cookieStoreId: parts[2] as string, backupName: parts[3] as string };
}
