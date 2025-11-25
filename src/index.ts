/* eslint-disable no-console */
import 'dotenv/config';
import os from 'node:os';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto'; 

// --- CONFIGURATION ---
const WALLET = process.env.WALLET || '';
const HOST_ID = process.env.HOST_ID || 'HOST-3090-1';
const DEVICE_ID = process.env.DEVICE_ID || os.hostname();
const COORD = process.env.COORD || 'http://127.0.0.1:8787';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

// 5.5 is "Goldilocks" mode. 
// 5 = Too fast. 
// 6 = Too slow. 
// 5.5 = Perfect (~5-10 seconds).
const MINING_DIFFICULTY = 5.5; 

if (!WALLET) {
  console.error('[miner] WALLET required');
  process.exit(1);
}

// --- GPU DETECTION ---
function detectGpuModel(): string | null {
  if (process.env.GPU_MODEL && process.env.GPU_MODEL.trim()) {
    return process.env.GPU_MODEL.trim();
  }
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name --format=csv,noheader,nounits',
      { encoding: 'utf8' },
    );
    const line = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    return line || null;
  } catch (e: any) {
    console.log('[miner] GPU detect failed (nvidia-smi missing).');
    return null;
  }
}

const GPU_MODEL = detectGpuModel();
console.log(`[miner] boot WALLET=${WALLET} HOST_ID=${HOST_ID} DEVICE_ID=${DEVICE_ID}`);
console.log(`[miner] GPU_MODEL="${GPU_MODEL || 'Unknown'}"`);

// --- TYPES ---
type HelloResp = { ok: boolean; bound?: boolean; hostId?: string; deviceId?: string; wallet?: string; error?: string; };
type HostState = { hostId: string; enabled: boolean; wallet: string | null; gpuReportedModel?: string | null; gpuVerified?: boolean; };
type ShareResp = { ok?: boolean; total?: number; error?: string };
type AiJob = { id: number; wallet: string; model_id: string; prompt: string; status: string; result?: string | null; error?: string | null; };
type AiJobNextResp = { ok?: boolean; job?: AiJob | null; error?: string; };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- API CALLS ---

async function hello(): Promise<HelloResp> {
  try {
    const r = await fetch(`${COORD}/host/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: HOST_ID, deviceId: DEVICE_ID, wallet: WALLET, gpuModel: GPU_MODEL || null }),
    });
    return (await r.json()) as HelloResp;
  } catch (e: any) {
    return { ok: false, error: e?.message || 'hello_failed' };
  }
}

async function hostState(): Promise<HostState | null> {
  try {
    const r = await fetch(`${COORD}/host-state?hostId=${encodeURIComponent(HOST_ID)}`);
    return (await r.json()) as HostState;
  } catch {
    return null;
  }
}

async function share(diff: number): Promise<ShareResp> {
  try {
    const r = await fetch(`${COORD}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: WALLET, hostId: HOST_ID, deviceId: DEVICE_ID, difficulty: diff }),
    });
    const j = (await r.json()) as ShareResp;
    if (!r.ok) return { ok: false, error: j?.error || `http_${r.status}` };
    return j;
  } catch (e: any) {
    return { ok: false, error: e?.message || 'share_failed' };
  }
}

async function fetchNextAiJob(): Promise<AiJob | null> {
  try {
    const url = new URL(`${COORD}/ai/jobs/next`);
    url.searchParams.set('hostId', HOST_ID);
    url.searchParams.set('deviceId', DEVICE_ID);

    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) return null;

    const j = (await r.json()) as AiJobNextResp;
    return j.job ?? null;
  } catch {
    return null;
  }
}

async function submitAiJobResult(jobId: number, result: string, error?: string): Promise<void> {
  try {
    await fetch(`${COORD}/ai/jobs/${jobId}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result, error: error || null }),
    });
  } catch (e: any) {
    console.log('[ai-worker] result failed', e?.message);
  }
}

async function runOllamaInference(modelId: string, prompt: string): Promise<string> {
  const engineModel = modelId.toLowerCase().includes('mistral') ? 'mistral' : 'llama3.1';

  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: engineModel, prompt: prompt, stream: false }),
  });

  if (!r.ok) throw new Error(`Ollama API error: ${r.statusText}`);
  const data: any = await r.json();
  return data.response; 
}

// -------------------- FRACTIONAL MINING LOGIC --------------------

function minePoW(difficulty: number) {
  // Separate integer (5) from fraction (0.5)
  const intDiff = Math.floor(difficulty); 
  const fracDiff = difficulty - intDiff;

  // e.g. "00000"
  const targetPrefix = '0'.repeat(intDiff);
  
  // Logic for the Next Character (the fraction):
  // Hex has 16 chars (0-f). 
  // If frac is 0.5, we want the top 50% (0-7).
  // If frac is 0.9, we want the top 10% (0-1).
  const maxNextCharVal = Math.floor(16 * (1 - fracDiff));

  let nonce = 0;
  const start = Date.now();
  const prefix = `${HOST_ID}-${DEVICE_ID}-${start}`;

  while (true) {
    const input = `${prefix}-${nonce}`;
    const hash = crypto.createHash('sha256').update(input).digest('hex');

    if (hash.startsWith(targetPrefix)) {
      // Check the fractional requirement on the next character
      if (fracDiff > 0) {
        const nextChar = parseInt(hash[intDiff], 16);
        if (nextChar <= maxNextCharVal) {
             const duration = Date.now() - start;
             return { nonce, hash, duration };
        }
      } else {
        // No fraction, just integer match
        const duration = Date.now() - start;
        return { nonce, hash, duration };
      }
    }
    nonce++;
  }
}

// -------------------- MINING WORKER --------------------

async function miningWorker() {
  console.log(`[miner] ⛏️  Starting SHA-256 Miner (Difficulty ${MINING_DIFFICULTY})...`);

  for (;;) {
    const h = await hello();
    if (!h.bound) { await delay(2000); continue; }

    const s = await hostState();
    if (!s?.enabled || !s.gpuVerified) {
      console.log('[miner] Host disabled or unverified. Pausing...');
      await delay(5000);
      continue;
    }

    // --- REAL WORK ---
    const solution = minePoW(MINING_DIFFICULTY);
    
    const r = await share(MINING_DIFFICULTY);
    
    if (r.ok) {
      console.log(`[miner] 💰 Share accepted! Time: ${solution.duration}ms | Total: ${r.total}`);
    } else {
      console.log(`[miner] Share rejected: ${r.error}`);
    }

    await delay(50);
  }
}

// -------------------- AI WORKER --------------------

async function aiWorker() {
  console.log('[ai-worker] starting AI job worker loop');
  for (;;) {
    try {
      const s = await hostState();
      if (!s?.enabled || !s.gpuVerified) { await delay(5000); continue; }

      const job = await fetchNextAiJob();
      if (!job) { await delay(2000); continue; } 

      console.log(`[ai-worker] ⚡ Claimed Job #${job.id} (${job.model_id})`);
      
      let result = '';
      let error = undefined;

      try {
        console.log(`[ai-worker] Sending to GPU (Ollama)...`);
        result = await runOllamaInference(job.model_id, job.prompt);
        console.log(`[ai-worker] Inference complete (${result.length} chars)`);
      } catch (err: any) {
        console.error('[ai-worker] Inference failed', err);
        error = err.message || 'GPU_INFERENCE_FAILED';
        result = 'Error generating response from GPU.';
      }

      await submitAiJobResult(job.id, result, error);
      console.log(`[ai-worker] Completed job id=${job.id}`);

    } catch (e: any) {
      console.error('[ai-worker] error', e?.message || e);
      await delay(5000);
    }
  }
}

// -------------------- STARTUP --------------------

async function start() {
  await Promise.all([miningWorker(), aiWorker()]);
}

start().catch((e) => {
  console.error('[miner] fatal', e);
  process.exit(1);
});