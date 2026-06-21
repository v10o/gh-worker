import express, { Request, Response, NextFunction } from 'express';
import { exec } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface Config {
  apiKeys: string[];
  allowedOrigins: string[];
  executionTimeoutMs: number;
  port: number;
}

interface ExecuteRequest {
  command?: string;
  commands?: string[];
  args?: string[];
  cwd?: string;
}

interface ExecuteResponse {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number | null;
}

interface CliArgs {
  port?: number;
  apiKeys?: string[];
  origins?: string[];
  timeout?: number;
  help?: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--port' || arg === '-p') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) result.port = val;
    } else if (arg === '--api-key' || arg === '-k') {
      result.apiKeys = result.apiKeys || [];
      result.apiKeys.push(args[++i]);
    } else if (arg === '--origin' || arg === '-o') {
      result.origins = result.origins || [];
      result.origins.push(args[++i]);
    } else if (arg === '--timeout' || arg === '-t') {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) result.timeout = val;
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
gh-worker - Code execution worker

Usage: node dist/index.js [options]

Options:
  -p, --port <port>       Server port (default: 8080)
  -k, --api-key <key>     API key (can use multiple times)
  -o, --origin <origin>   Allowed origin (can use multiple times)
  -t, --timeout <ms>      Execution timeout in ms (default: 30000)
  -h, --help              Show this help

Examples:
  node dist/index.js --port 3000 --api-key mykey123
  node dist/index.js -p 8080 -k key1 -k key2 -o http://localhost:3000
`);
}

function loadConfig(): Config {
  const configPath = join(__dirname, '..', 'config.json');
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  }
  // Default config if file missing
  return {
    apiKeys: [],
    allowedOrigins: ['*'],
    executionTimeoutMs: 30000,
    port: 8080
  };
}

function buildConfig(): Config {
  const fileConfig = loadConfig();
  const cliArgs = parseArgs();

  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  // CLI args override file config
  return {
    apiKeys: cliArgs.apiKeys?.length ? cliArgs.apiKeys : fileConfig.apiKeys,
    allowedOrigins: cliArgs.origins?.length ? cliArgs.origins : fileConfig.allowedOrigins,
    executionTimeoutMs: cliArgs.timeout ?? fileConfig.executionTimeoutMs,
    port: cliArgs.port ?? fileConfig.port
  };
}

let config = buildConfig();

// Validate config
if (config.apiKeys.length === 0) {
  console.error('Error: No API keys configured. Use --api-key or config.json');
  process.exit(1);
}

// Reload config on SIGHUP (CLI args still override)
process.on('SIGHUP', () => {
  console.log('Reloading config...');
  config = buildConfig();
  console.log('Config reloaded');
});

const app = express();
app.use(express.json());

// CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;

  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  }

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

// Auth middleware
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || !config.apiKeys.includes(apiKey as string)) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }

  next();
}

// Execute command with timeout
function executeCommand(command: string, timeoutMs: number, cwd?: string): Promise<ExecuteResponse> {
  return new Promise((resolve) => {
    const child = exec(command, { timeout: timeoutMs, cwd }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          stdout,
          stderr,
          error: error.message,
          exitCode: typeof error.code === 'number' ? error.code : null
        });
        return;
      }

      resolve({
        success: true,
        stdout,
        stderr,
        exitCode: 0
      });
    });
  });
}

// POST /execute
app.post('/execute', authMiddleware, async (req: Request, res: Response) => {
  const body = req.body as ExecuteRequest;

  // Build command list
  let commands: string[] = [];

  if (body.commands && Array.isArray(body.commands)) {
    commands = body.commands.filter(c => typeof c === 'string');
  } else if (body.command && typeof body.command === 'string') {
    let cmd = body.command;
    if (body.args && Array.isArray(body.args)) {
      const escapedArgs = body.args.map(arg => `'${arg.replace(/'/g, "'\\''")}'`);
      cmd = `${body.command} ${escapedArgs.join(' ')}`;
    }
    commands = [cmd];
  }

  if (commands.length === 0) {
    res.status(400).json({ error: 'command or commands is required' });
    return;
  }

  // Chain commands with && (fail-fast)
  const fullCommand = commands.join(' && ');

  console.log(`Executing: ${fullCommand}${body.cwd ? ` (cwd: ${body.cwd})` : ''}`);

  const result = await executeCommand(fullCommand, config.executionTimeoutMs, body.cwd);

  res.json(result);
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.listen(config.port, () => {
  console.log(`Worker running on port ${config.port}`);
  console.log(`Timeout: ${config.executionTimeoutMs}ms`);
  console.log(`Allowed origins: ${config.allowedOrigins.join(', ')}`);
});
