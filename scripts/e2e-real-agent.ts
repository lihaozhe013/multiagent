import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageEngine } from '../src/core/store.ts';
import { QueueController } from '../src/core/queue.ts';
import { defaultAgentRegistry } from '../src/adapters/registry.ts';
import { PipelineRunner } from '../src/core/pipeline.ts';

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

async function main() {
  console.log(`${c.bold}${c.cyan}====================================================${c.reset}`);
  console.log(`${c.bold}${c.cyan}   Night-Shift Orchestrator - Real Agent E2E Test   ${c.reset}`);
  console.log(`${c.bold}${c.cyan}====================================================${c.reset}\n`);

  // Parse CLI args
  const args = process.argv.slice(2);
  const agentArg = args.find((a) => a.startsWith('--agent='));
  const agentId = agentArg ? agentArg.split('=')[1] : 'pi';
  const keepTemp = args.includes('--keep');
  const modelArg = args.find((a) => a.startsWith('--model='));
  const customModel = modelArg ? modelArg.split('=')[1] : (agentId === 'opencode' ? 'opencode-go/deepseek-v4.1-flash' : undefined);
  if (customModel) {
    if (agentId === 'opencode') process.env.OPENCODE_MODEL = customModel;
    if (agentId === 'pi') process.env.PI_MODEL = customModel;
    console.log(`  ${c.dim}Using custom model override: ${c.bold}${customModel}${c.reset}`);
  }

  console.log(`${c.dim}[1/6] Inspecting Agent Adapter: ${c.bold}${agentId}${c.reset}`);
  const adapter = defaultAgentRegistry.get(agentId);
  if (!adapter) {
    console.error(`${c.red}Error: Unknown agent adapter '${agentId}'. Available: ${defaultAgentRegistry.listIds().join(', ')}${c.reset}`);
    process.exit(1);
  }

  const readiness = await adapter.checkReadiness();
  if (!readiness.ok) {
    console.error(`${c.red}Error: Adapter '${agentId}' is not ready: ${readiness.error}${c.reset}`);
    process.exit(1);
  }
  console.log(`  ${c.green}✓${c.reset} Agent CLI ready: ${c.bold}${readiness.executablePath}${c.reset} (version: ${readiness.version})`);

  // Step 2: Initialize isolated sandbox Git repository
  console.log(`\n${c.dim}[2/6] Initializing isolated temporary Git sandbox...${c.reset}`);
  const sandbox = mkdtempSync(join(tmpdir(), 'nightshift-real-e2e-'));
  console.log(`  ${c.green}✓${c.reset} Sandbox path: ${sandbox}`);

  // Git init & initial commit
  const initProc = Bun.spawn(['git', 'init'], { cwd: sandbox, stdout: 'ignore', stderr: 'ignore' });
  await initProc.exited;

  const cfgUser = Bun.spawn(['git', 'config', 'user.name', 'NightShift-E2E'], { cwd: sandbox });
  await cfgUser.exited;
  const cfgEmail = Bun.spawn(['git', 'config', 'user.email', 'e2e@nightshift.local'], { cwd: sandbox });
  await cfgEmail.exited;

  const initialSecret = `SECRET-PAYLOAD-${Date.now()}`;
  writeFileSync(join(sandbox, 'mission.txt'), `Mission Token: ${initialSecret}\nTarget: Read this token, sleep 2s, and generate output.txt\n`);

  const addProc = Bun.spawn(['git', 'add', '.'], { cwd: sandbox });
  await addProc.exited;
  const commitProc = Bun.spawn(['git', 'commit', '-m', 'chore: initial sandbox setup'], { cwd: sandbox });
  await commitProc.exited;
  console.log(`  ${c.green}✓${c.reset} Created initial commit with input file: mission.txt`);

  // Step 3: Setup database & Queue
  console.log(`\n${c.dim}[3/6] Setting up ephemeral SQLite queue...${c.reset}`);
  const db = new StorageEngine(':memory:');
  const queue = new QueueController(db);

  const task = queue.createTask({
    title: 'Real Model E2E Verification',
    agent_id: agentId,
    description: `Please perform the following operations in sequence:
1. Read the contents of 'mission.txt'.
2. Execute bash command 'sleep 2' to verify sub-process control.
3. Write a new file named 'output.txt' containing:
   - Line 1: 'VERIFICATION_SUCCESS'
   - Line 2: The exact contents read from 'mission.txt'
4. Finish promptly once 'output.txt' is written. Do not ask for user confirmation.`,
    verify_commands: [
      'test -f output.txt',
      'grep -q "VERIFICATION_SUCCESS" output.txt',
      `grep -q "${initialSecret}" output.txt`,
    ],
    cwd: sandbox,
    timeout_seconds: 120,
    max_retries: 2,
  });
  console.log(`  ${c.green}✓${c.reset} Enqueued Task #${task.id}: "${task.title}"`);

  // Step 4: Run Real Pipeline with Event Streaming
  console.log(`\n${c.dim}[4/6] Executing real agent micro-pipeline (Coder -> Test Gate -> Review)...${c.reset}`);
  const runner = new PipelineRunner(queue, defaultAgentRegistry);

  runner.addEventListener((event) => {
    const timestampStr = new Date(event.timestamp).toLocaleTimeString();
    if (event.type === 'stdout') {
      console.log(`  ${c.blue}[${timestampStr} - ${event.stage}]${c.reset} ${event.content}`);
    } else if (event.type === 'stderr') {
      console.log(`  ${c.yellow}[${timestampStr} - ${event.stage} STDERR]${c.reset} ${event.content.trim()}`);
    } else if (event.type === 'thinking') {
      const preview = event.content.trim().slice(0, 100).replace(/\n/g, ' ');
      console.log(`  ${c.magenta}[${timestampStr} - ${event.stage} THINK]${c.reset} ${preview}...`);
    } else if (event.type === 'tool_call') {
      console.log(`  ${c.cyan}[${timestampStr} - ${event.stage} TOOL]${c.reset} ${event.content}`);
    } else if (event.type === 'error') {
      console.log(`  ${c.red}[${timestampStr} - ${event.stage} ERROR]${c.reset} ${event.content}`);
    }
  });

  const claim = queue.claimNext();
  if (!claim) {
    throw new Error('Failed to claim pending task');
  }

  const startTime = Date.now();
  const finishedTask = await runner.runTask(claim.task, claim.token);
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  // Step 5: Verification & Assertions
  console.log(`\n${c.dim}[5/6] Verifying results and Git artifacts...${c.reset}`);
  console.log(`  Pipeline finished with status: ${finishedTask.status === 'DONE' ? c.green + 'DONE' : c.red + finishedTask.status}${c.reset} (took ${durationSec}s)`);

  const outputFile = join(sandbox, 'output.txt');
  if (!existsSync(outputFile)) {
    throw new Error(`Assertion failed: output.txt was not created at ${outputFile}`);
  }

  const outputContent = readFileSync(outputFile, 'utf-8');
  console.log(`  ${c.green}✓${c.reset} Output file contents:\n${c.dim}----------------------------------------\n${outputContent.trim()}\n----------------------------------------${c.reset}`);

  if (!outputContent.includes('VERIFICATION_SUCCESS') || !outputContent.includes(initialSecret)) {
    throw new Error('Assertion failed: output.txt content does not match expected payload');
  }
  console.log(`  ${c.green}✓${c.reset} Output content verified successfully!`);

  // Verify Git commit created by pipeline
  const logProc = Bun.spawn(['git', 'log', '-1', '--oneline'], { cwd: sandbox, stdout: 'pipe' });
  const lastCommit = (await new Response(logProc.stdout).text()).trim();
  console.log(`  ${c.green}✓${c.reset} Last Git commit: ${c.bold}${lastCommit}${c.reset}`);

  // Step 6: Cleanup
  console.log(`\n${c.dim}[6/6] Cleanup & Summary...${c.reset}`);
  if (keepTemp) {
    console.log(`  ${c.yellow}!${c.reset} Sandbox kept at: ${sandbox}`);
  } else {
    rmSync(sandbox, { recursive: true, force: true });
    console.log(`  ${c.green}✓${c.reset} Temporary sandbox removed.`);
  }

  db.close();

  console.log(`\n${c.bold}${c.green}====================================================${c.reset}`);
  console.log(`${c.bold}${c.green}   Real Agent E2E Integration Test: ALL PASSED!    ${c.reset}`);
  console.log(`${c.bold}${c.green}   Total Elapsed Time: ${durationSec}s${c.reset}`);
  console.log(`${c.bold}${c.green}====================================================${c.reset}\n`);
}

main().catch((err) => {
  console.error(`\n${c.bold}${c.red}E2E Test Failed:${c.reset}`, err);
  process.exit(1);
});
