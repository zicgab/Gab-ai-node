// The only models a node knows. Every file is pinned to a repo commit and its
// SHA-256 (taken from the Hugging Face API), so a changed upload is refused.
// memoryMb = file size + KV cache for contextSize; used by the memory-fit check.
// Which model serves which task is decided here (useFor) and in pick.ts; nothing is configurable per node.

/** A file of a model, pinned by size and SHA-256. */
export interface PinnedFile {
  file: string;
  sha256: string;
  sizeBytes: number;
}

export interface CatalogEntry extends PinnedFile {
  id: string;
  role: string;
  repo: string;
  revision: string;
  memoryMb: number;
  contextSize: number;
  /** Extra llama-server arguments for this model. */
  serverArgs: string[];
  /** Roles and task kinds this model serves when it is installed (a judgment, not a benchmark). */
  useFor: string[];
  /** The model can read images (screenshots of test_web / test_electron); it needs its mmproj file. */
  vision?: boolean;
  /** The multimodal projector llama-server loads next to a vision model. */
  mmproj?: PinnedFile;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'qwen3-coder-30b',
    role: 'fast: ask, chat, translate, frontend, backend, custom',
    repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    revision: 'b17cb02dd882d5b6ab62fc777ad2995f19668350',
    file: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',
    sha256: 'fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad',
    sizeBytes: 18_556_689_568,
    memoryMb: 24_576,
    contextSize: 65_536,
    serverArgs: [],
    useFor: ['frontend', 'backend', 'ask', 'chat', 'translate', 'custom', 'contract_check', 'test_mobile', 'eval'],
  },
  {
    id: 'gpt-oss-120b',
    role: 'deep: bug_hunt, fix_finding, scan, security (needs ~72 GB)',
    repo: 'ggml-org/gpt-oss-120b-GGUF',
    revision: '238abdd290bb874b90a5da1b4549881b7d05c091',
    file: 'gpt-oss-120b-MXFP4.gguf',
    sha256: '582bd40f6886200101f4c4ed9f25f3fe80cc14c86e9e2b37746cd8904a0c622d',
    sizeBytes: 63_387_346_208,
    memoryMb: 71_680,
    contextSize: 65_536,
    serverArgs: [],
    useFor: ['security', 'uxui', 'bug_hunt', 'fix_finding', 'scan', 'docs_check'],
  },
  {
    id: 'qwen3-vl-30b',
    role: 'vision: test_web, test_electron (reads screenshots)',
    repo: 'Qwen/Qwen3-VL-30B-A3B-Instruct-GGUF',
    revision: 'f54435e6cc31258f04b0969105c3f6badb197931',
    file: 'Qwen3VL-30B-A3B-Instruct-Q4_K_M.gguf',
    sha256: '87bb374d849f80ebdfabb304189fac9e0bd35a0f74506e6a59c51b206cbe863b',
    sizeBytes: 18_556_687_168,
    memoryMb: 26_624,
    contextSize: 65_536,
    serverArgs: [],
    useFor: ['test_web', 'test_electron'],
    vision: true,
    mmproj: {
      file: 'mmproj-Qwen3VL-30B-A3B-Instruct-Q8_0.gguf',
      sha256: '82a9966edfdbc1b18a27fd90af96d50cbf111a51484f6290e946dccf461c8150',
      sizeBytes: 712_148_928,
    },
  },
];

export function catalogEntry(id: string, catalog: readonly CatalogEntry[] = CATALOG): CatalogEntry {
  const e = catalog.find((m) => m.id === id);
  if (!e) throw new Error(`unknown model ${id}; known: ${catalog.map((m) => m.id).join(', ')}`);
  return e;
}

/** Every file a model needs on disk: the model itself, then its projector when it has one. */
export function catalogFiles(e: CatalogEntry): PinnedFile[] {
  return [{ file: e.file, sha256: e.sha256, sizeBytes: e.sizeBytes }, ...(e.mmproj ? [e.mmproj] : [])];
}

/** Total bytes to download for a model. */
export const totalBytes = (e: CatalogEntry): number => catalogFiles(e).reduce((sum, f) => sum + f.sizeBytes, 0);

export function downloadUrl(e: CatalogEntry, file: string = e.file): string {
  return `https://huggingface.co/${e.repo}/resolve/${e.revision}/${encodeURIComponent(file)}`;
}
