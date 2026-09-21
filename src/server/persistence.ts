import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectState } from '../core/model.js';
import { sha256Hex } from '../core/store.js';

export const PROJECT_DIR = '.loom-project';
const STATE_FILE = 'state.json';
const RAW_DIR = 'raw';

export interface PersistenceLayout {
  dir: string;
  statePath: string;
  rawDir: string;
}

export function layout(rootDir: string): PersistenceLayout {
  const dir = join(rootDir, PROJECT_DIR);
  return { dir, statePath: join(dir, STATE_FILE), rawDir: join(dir, RAW_DIR) };
}

export function saveState(rootDir: string, state: ProjectState): void {
  const l = layout(rootDir);
  mkdirSync(l.rawDir, { recursive: true });
  writeFileSync(l.statePath, JSON.stringify(state, null, 2), 'utf8');
}

export function saveRawWitness(rootDir: string, witnessId: string, rawXml: string): string {
  const l = layout(rootDir);
  mkdirSync(l.rawDir, { recursive: true });
  const safe = witnessId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = join(l.rawDir, `${safe}.xml`);
  writeFileSync(path, rawXml, 'utf8');
  return path;
}

/**
 * 重启恢复：读取 state.json，并校验每个原始文件与 sha256 一致；
 * state 里保存的 rawXml 也作为第二副本，磁盘文件丢失时恢复。
 */
export function loadState(rootDir: string): ProjectState | null {
  const l = layout(rootDir);
  if (!existsSync(l.statePath)) return null;
  const parsed = JSON.parse(readFileSync(l.statePath, 'utf8')) as ProjectState;
  for (const witness of parsed.witnesses) {
    const safe = witness.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const rawPath = join(l.rawDir, `${safe}.xml`);
    if (existsSync(rawPath)) {
      const disk = readFileSync(rawPath, 'utf8');
      if (sha256Hex(disk) === witness.sha256) {
        witness.rawXml = disk;
        continue;
      }
      if (sha256Hex(witness.rawXml) === witness.sha256) {
        throw new Error(
          `见证 ${witness.id}（${witness.name}）的磁盘原文与导入时 sha256 校验失败（内容不一致），` +
          `疑似被外部篡改，已拒绝加载；如需恢复请删除 ${rawPath} 后用 state.json 内副本重建`,
        );
      }
      throw new Error(`见证 ${witness.id} 的原始 XML 校验失败，数据可能已损坏`);
    }
    if (sha256Hex(witness.rawXml) !== witness.sha256) {
      throw new Error(`见证 ${witness.id} 的 state.json 内原文校验失败，数据可能已损坏`);
    }
    saveRawWitness(rootDir, witness.id, witness.rawXml);
  }
  return parsed;
}
