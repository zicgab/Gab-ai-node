// Models a node may download. Every file is pinned to a repo commit and its
// SHA-256 (taken from the Hugging Face API), so a changed upload is refused.
// memoryMb = file size + KV cache for contextSize; used by the memory-fit check.
export interface CatalogEntry {
  id: string;
  role: string;
  repo: string;
  revision: string;
  file: string;
  sha256: string;
  sizeBytes: number;
  memoryMb: number;
  contextSize: number;
  /** Extra llama-server arguments for this model. */
  serverArgs: string[];
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'qwen3-coder-30b',
    role: 'fast: ask, code lookup, translate',
    repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    revision: 'b17cb02dd882d5b6ab62fc777ad2995f19668350',
    file: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',
    sha256: 'fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad',
    sizeBytes: 18_556_689_568,
    memoryMb: 24_576,
    contextSize: 65_536,
    serverArgs: [],
  },
  {
    id: 'gpt-oss-120b',
    role: 'deep: bug_hunt, fix_finding (needs ~70 GB)',
    repo: 'ggml-org/gpt-oss-120b-GGUF',
    revision: '238abdd290bb874b90a5da1b4549881b7d05c091',
    file: 'gpt-oss-120b-MXFP4.gguf',
    sha256: '582bd40f6886200101f4c4ed9f25f3fe80cc14c86e9e2b37746cd8904a0c622d',
    sizeBytes: 63_387_346_208,
    memoryMb: 71_680,
    contextSize: 65_536,
    serverArgs: [],
  },
  {
    id: 'gpt-oss-20b',
    role: 'small machines: ask, translate',
    repo: 'ggml-org/gpt-oss-20b-GGUF',
    revision: 'ef9b12f2ff56c69cf32153a02784e7a3c88bf524',
    file: 'gpt-oss-20b-MXFP4.gguf',
    sha256: '27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901',
    sizeBytes: 12_109_566_624,
    memoryMb: 16_384,
    contextSize: 65_536,
    serverArgs: [],
  },
];

export function catalogEntry(id: string, catalog: readonly CatalogEntry[] = CATALOG): CatalogEntry {
  const e = catalog.find((m) => m.id === id);
  if (!e) throw new Error(`unknown model ${id}; known: ${catalog.map((m) => m.id).join(', ')}`);
  return e;
}

export function downloadUrl(e: CatalogEntry): string {
  return `https://huggingface.co/${e.repo}/resolve/${e.revision}/${encodeURIComponent(e.file)}`;
}
