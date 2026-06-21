import express, { Request, Response, NextFunction } from 'express';
import { exec } from 'child_process';
import { readFileSync } from 'fs';
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

function loadConfig(): Config {
  const configPath = join(__dirname, '..', 'config.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

let config = loadConfig();

// Reload config on SIGHUP
process.on('SIGHUP', () => {
  console.log('Reloading config...');
  config = loadConfig();
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
