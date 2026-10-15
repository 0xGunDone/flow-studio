#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { BridgeClient, BridgeError } = require('./bridge-client.cjs');

const text = (max = 200) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Must not be blank');
const absolutePath = text(4096).refine(value => path.isAbsolute(value) && !value.includes('\0'), 'Use an absolute local file path');
const imagePath = absolutePath.refine(value => /\.(png|jpe?g|webp|gif)$/i.test(value), 'Use a PNG, JPEG, WebP, or GIF file path');
const jobId = text();
const index = z.number().int().min(0).optional();
const schemas = {
  status: z.object({}).strict(),
  models: z.object({ kind: z.enum(['image', 'video']).optional(), mode: z.enum(['text', 'references', 'frames', 'extend']).optional(), query: text(300).optional() }).strict(),
  generate: z.object({
    model: text().describe('Exact id from list_models; do not silently substitute another model.'),
    prompt: text(20000).describe('User-requested prompt, preserved without silent edits.'),
    referencePaths: z.array(imagePath).min(1).max(5).optional().describe('Absolute local image paths. Up to 5 image references or 3 video references, subject to model limits. Do not combine with frames or sourceVideoId.'),
    startFramePath: imagePath.optional().describe('Required start image for a frames model. Do not combine with referencePaths or sourceVideoId.'),
    endFramePath: imagePath.optional().describe('Optional end image, only with startFramePath and a model supporting end frames.'),
    sourceVideoId: text().optional().describe('Existing video media id for a supported extension model. Do not combine with references or frames.'),
    confirmCreditSpend: z.literal(true).describe('Set true only when user requested this generation. That request authorizes credit spend; do not ask redundantly.'),
    requestId: text(128).describe('Unique stable id for this intended generation. Reuse the same id and exact inputs on a retry; use a new id only for a new user-requested generation.'),
  }).strict(),
  job: z.object({ jobId }).strict(),
  wait: z.object({ jobId, timeoutSeconds: z.number().min(0).max(30).optional() }).strict(),
  history: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
  save: z.object({ jobId, index, outputPath: absolutePath, overwrite: z.boolean().optional().describe('Default false. Set true only when user explicitly authorized replacing that file.') }).strict(),
  open_folder: z.object({ jobId, index }).strict(),
  accounts: z.object({}).strict(),
  login_start: z.object({ accountId: z.number().int().min(1).optional() }).strict(),
  login_complete: z.object({}).strict(),
  login_cancel: z.object({}).strict(),
  cancel: z.object({ jobId }).strict(),
};

const generateSchema = schemas.generate.superRefine((value, context) => {
  const sources = Number(Boolean(value.referencePaths)) + Number(Boolean(value.startFramePath || value.endFramePath)) + Number(Boolean(value.sourceVideoId));
  if (sources > 1) context.addIssue({ code: z.ZodIssueCode.custom, message: 'referencePaths, frame paths, and sourceVideoId are mutually exclusive.' });
  if (value.endFramePath && !value.startFramePath) context.addIssue({ code: z.ZodIssueCode.custom, path: ['startFramePath'], message: 'endFramePath requires startFramePath.' });
});

const definitions = [
  ['status', 'status', 'Read app status', 'Read readiness, account summaries, credits, running jobs, and history count. Starts installed Flow Studio if needed.', true, false, true, false],
  ['list_models', 'models', 'List generation models', 'List current exact model ids and supported inputs. Catalog presence does not guarantee Google account access. Choose requested model; no silent fallback.', true, false, true, true],
  ['generate', 'generate', 'Generate image or video', 'Spend credits on one user-requested generation, returning jobId immediately. Call get_job or bounded wait_job until done, then save_result. Reuse requestId and exact inputs for retry. Never automatically resubmit a failed or cancelled job. References, frames, and sourceVideoId are mutually exclusive; frame order is start then end.', false, true, true, true],
  ['get_job', 'job', 'Read generation job', 'Read job status and returned media localPath/url/savedPath. No authentication data is returned.', true, false, true, false],
  ['wait_job', 'wait', 'Wait for generation job', 'Wait up to 30 seconds for a job; returns {job, done}. Repeat bounded waits while unfinished. Timeout does not start another job.', true, false, true, false],
  ['list_jobs', 'history', 'Read recent jobs', 'List persisted generation jobs, newest first, including saved result paths.', true, false, true, false],
  ['save_result', 'save', 'Save generated media', 'Save a selected result to an explicit absolute outputPath. Parent directory must exist. Refuses existing files unless overwrite is explicitly true.', false, true, false, false],
  ['open_result_folder', 'open_folder', 'Reveal generated media', 'Reveal saved result, or local cached result, in Finder.', false, false, true, false],
  ['list_accounts', 'accounts', 'List Google accounts', 'Read account ids, email, credit balance, and active status. Returns no cookies, tokens, or credentials.', true, false, true, true],
  ['begin_google_login', 'login_start', 'Begin Google sign-in', 'Open human Google sign-in flow. User enters credentials in browser; never request passwords or cookies. Optional accountId reauthenticates an existing account.', false, false, false, true],
  ['complete_google_login', 'login_complete', 'Finish Google sign-in', 'Finish sign-in after user completes the browser flow; save account privately in Flow Studio.', false, false, false, true],
  ['cancel_google_login', 'login_cancel', 'Cancel Google sign-in', 'Close the pending Google sign-in flow.', false, false, true, false],
  ['cancel_job', 'cancel', 'Cancel generation job', 'Abort this app request. Google may still finish generation or charge credits. Do not automatically resubmit.', false, true, true, true],
].map(([name, method, title, description, readOnlyHint, destructiveHint, idempotentHint, openWorldHint]) => ({
  name: `flow_studio_${name}`, method, title, description,
  annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint },
}));

async function dispatch(client, method, params, options) {
  if (!Object.prototype.hasOwnProperty.call(schemas, method)) throw new BridgeError('UNKNOWN_METHOD', `Unknown Flow Studio method: ${method}`);
  const parsed = (method === 'generate' ? generateSchema : schemas[method]).safeParse(params);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENTS', parsed.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
  return client.call(method, parsed.data, options);
}

function createServer(client = new BridgeClient()) {
  const server = new McpServer({ name: 'flow-studio', version: '1.0.0' }, {
    instructions: 'Control the installed Flow Studio app through its private local bridge. Use list_models, then generate with user authorization and a stable requestId. Generation is asynchronous: inspect/wait for the job, then save_result. Never reveal backend credentials or silently change model/prompt after a failure.',
    maxToolInputElements: 100,
  });
  for (const definition of definitions) {
    const { name, method, ...metadata } = definition;
    server.registerTool(name, { ...metadata, inputSchema: schemas[method] }, async (params, extra) => {
      try {
        const result = await dispatch(client, method, params, { signal: extra.signal });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : { result } };
      } catch (error) {
        const failure = { error: { code: error.code || 'FLOW_STUDIO_ERROR', message: error.message } };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
      }
    });
  }
  return server;
}

async function main(args) {
  if (args[0] === '--list-tools' && args.length === 1) {
    process.stdout.write(`${JSON.stringify({ tools: definitions.map(definition => ({ ...definition, parameters: Object.keys(schemas[definition.method].shape) })) }, null, 2)}\n`);
    return;
  }
  if (args[0] === '--call' && args.length === 3) {
    let params;
    try { params = JSON.parse(args[2]); }
    catch { throw new BridgeError('INVALID_ARGUMENTS', 'Parameters must be valid JSON.'); }
    const result = await dispatch(new BridgeClient(), args[1], params);
    process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
    return;
  }
  if (args.length) throw new BridgeError('INVALID_ARGUMENTS', 'Usage: node mcp-server.cjs [--list-tools | --call <method> <JSON>]');
  await createServer().connect(new StdioServerTransport());
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  const output = JSON.stringify({ error: { code: error.code || 'FLOW_STUDIO_ERROR', message: error.message } });
  (process.argv[2] === '--call' ? process.stdout : process.stderr).write(`${output}\n`);
  process.exitCode = 1;
});

module.exports = { createServer, dispatch, definitions, schemas };
