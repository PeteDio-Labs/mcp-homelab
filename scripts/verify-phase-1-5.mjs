#!/usr/bin/env bun

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const APP_DIR = process.cwd();
const DOCS_ROOT = process.env.DOCS_ROOT ?? '/home/pedro/PeteDio-Labs/knowledge';
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://192.168.50.60:30300';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL ?? 'http://192.168.50.60:30302';
const BLOG_API_URL = process.env.BLOG_API_URL ?? 'http://localhost:8080';
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://192.168.50.59:11434';
const CODER_MODEL = process.env.CODER_MODEL ?? 'gemma4:e4b';
const TASK_TIMEOUT_MS = Number.parseInt(process.env.PHASE15_TASK_TIMEOUT_MS ?? '180000', 10);
const TASK_POLL_MS = Number.parseInt(process.env.PHASE15_TASK_POLL_MS ?? '5000', 10);

const REQUIRED_AGENTS = [
  'blog-agent',
  'ops-investigator',
  'knowledge-janitor',
  'workstation-agent',
  'infra-agent',
];

const EXPECTED_TOOLS = [
  'list_agents',
  'list_agent_queue',
  'run_agent',
  'get_task_status',
  'list_docs',
  'gather_context',
  'run_infra_check',
  'proxmox_nodes',
  'rag_query',
  'run_workstation_task',
];

function printStep(name, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status} ${name}${detail ? ` :: ${detail}` : ''}`);
}

function printOptional(name, detail = '') {
  console.log(`WARN ${name}${detail ? ` :: ${detail}` : ''}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toolText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function extractTaskId(text) {
  const match = text.match(/taskId:\s*([A-Za-z0-9-]+)/);
  return match?.[1] ?? null;
}

function extractStatus(text) {
  const match = text.match(/^status:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isBlogApiAvailable() {
  try {
    const res = await fetch(`${BLOG_API_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: '/home/pedro/.bun/bin/bun',
    args: ['run', 'src/index.ts'],
    cwd: APP_DIR,
    env: {
      ...process.env,
      MCP_TRANSPORT: 'stdio',
      DOCS_ROOT,
      MC_BACKEND_URL,
      NOTIFICATION_SERVICE_URL,
      BLOG_API_URL,
      OLLAMA_URL,
      CODER_MODEL,
    },
    stderr: 'pipe',
  });

  const stderr = transport.stderr;
  if (stderr) {
    stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        process.stderr.write(`[mcp-homelab] ${text}\n`);
      }
    });
  }

  const client = new Client(
    { name: 'phase15-verifier', version: '1.0.0' },
    { capabilities: {} },
  );

  async function callTool(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = toolText(result);
    assert(!result.isError, `${name} returned MCP error\n${text}`);
    return text;
  }

  async function waitForTask(taskId, label) {
    const start = Date.now();
    while (Date.now() - start < TASK_TIMEOUT_MS) {
      const text = await callTool('get_task_status', { taskId });
      const status = extractStatus(text);
      if (status && !['queued', 'running'].includes(status)) {
        printStep(label, status === 'complete', `status=${status}`);
        assert(status === 'complete', `${label} finished with status=${status}\n${text}`);
        return text;
      }
      await sleep(TASK_POLL_MS);
    }
    throw new Error(`${label} timed out after ${TASK_TIMEOUT_MS}ms`);
  }

  try {
    await client.connect(transport);

    const listedTools = await client.listTools();
    const toolNames = listedTools.tools.map((tool) => tool.name);
    for (const toolName of EXPECTED_TOOLS) {
      assert(toolNames.includes(toolName), `missing tool: ${toolName}`);
    }
    printStep('list_tools', true, `${toolNames.length} tools exposed`);

    const listAgentsText = await callTool('list_agents');
    const listedAgents = Array.from(listAgentsText.matchAll(/^agent:\s*(.+)$/gm)).map((match) => match[1].trim());
    for (const agentName of REQUIRED_AGENTS) {
      assert(listedAgents.includes(agentName), `list_agents missing ${agentName}`);
    }
    printStep('list_agents', true, `${listedAgents.length} agents listed`);

    const queueText = await callTool('list_agent_queue');
    assert(queueText.length > 0, 'list_agent_queue returned empty output');
    printStep('list_agent_queue', true, queueText.split('\n')[0]);

    const opsTriggerText = await callTool('run_agent', {
      agentName: 'ops-investigator',
      input: { mode: 'full-check' },
    });
    const opsTaskId = extractTaskId(opsTriggerText);
    assert(opsTaskId, `run_agent did not return taskId\n${opsTriggerText}`);
    printStep('run_agent ops-investigator', true, opsTaskId);
    await waitForTask(opsTaskId, 'get_task_status ops-investigator');

    const listDocsText = await callTool('list_docs', { category: 'all' });
    const docs = JSON.parse(listDocsText);
    assert(Array.isArray(docs) && docs.length > 0, 'list_docs returned no docs');
    printStep('list_docs', true, `${docs.length} docs`);

    const gatherContextText = await callTool('gather_context', {
      sessionCount: 1,
      format: 'readable',
    });
    assert(gatherContextText.length > 200, 'gather_context output too short');
    printStep('gather_context', true, `${gatherContextText.length} chars`);

    const infraTriggerText = await callTool('run_infra_check', { mode: 'health-check' });
    const infraTaskId = extractTaskId(infraTriggerText);
    assert(infraTaskId, `run_infra_check did not return taskId\n${infraTriggerText}`);
    printStep('run_infra_check', true, infraTaskId);
    await waitForTask(infraTaskId, 'get_task_status infra-agent');

    const proxmoxNodesText = await callTool('proxmox_nodes');
    const proxmoxNodes = JSON.parse(proxmoxNodesText);
    assert(Array.isArray(proxmoxNodes) && proxmoxNodes.length > 0, 'proxmox_nodes returned no nodes');
    printStep('proxmox_nodes', true, `${proxmoxNodes.length} nodes`);

    if (await isBlogApiAvailable()) {
      const ragText = await callTool('rag_query', {
        query: 'deterministic runner',
        topK: 3,
      });
      if (ragText.startsWith('RAG query error:') || ragText.startsWith('No results found')) {
        printOptional('rag_query', ragText.split('\n')[0]);
      } else {
        printStep('rag_query', true, ragText.split('\n')[0]);
      }
    } else {
      printOptional('rag_query', 'skipped: blog-api unavailable');
    }

    const workstationTriggerText = await callTool('run_workstation_task', {
      mode: 'git-status',
      workDir: '/home/pedro/PeteDio-Labs',
    });
    const workstationTaskId = extractTaskId(workstationTriggerText);
    assert(workstationTaskId, `run_workstation_task did not return taskId\n${workstationTriggerText}`);
    printStep('run_workstation_task', true, workstationTaskId);
    await waitForTask(workstationTaskId, 'get_task_status workstation-agent');

    console.log('PHASE_1_5_COMPLETE');
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
