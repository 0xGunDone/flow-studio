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
const videoPath = absolutePath.refine(value => /\.(mp4|mov|m4v)$/i.test(value), 'Use an MP4, MOV, or M4V file path');
const jobId = text();
const index = z.number().int().min(0).optional();
const generationMethod = z.enum(['image', 'text', 'ingredients', 'frames', 'edit', 'extend']);
const generationSettings = z.object({
  kind: z.enum(['image', 'video']),
  method: generationMethod,
  family: text().describe('Exact family from list_models, for example Veo 3.1 Fast.'),
  durationSeconds: z.number().int().min(1).max(60).optional().describe('Required for video text, ingredients, frames and extend. Omit for images and edit; edit follows source duration.'),
  aspectRatio: text(20).describe('Exact catalog aspectRatio, for example 16:9 or 9:16.'),
  resolution: text(30).optional().describe('Exact catalog resolution; omitted means standard. No fuzzy matching or fallback.'),
}).strict();
const generationFields = {
  model: text().optional().describe('Exact id from list_models. Supply either model or settings, never both.'),
  settings: generationSettings.optional().describe('Separate UI-style settings, resolved to one exact catalog model. Unavailable or ambiguous combinations fail without substitution.'),
  method: generationMethod.optional().describe('Optional explicit input method with exact model only. Do not combine with settings. Text rejects ingredients; frames require explicit frame roles.'),
  prompt: text(20000).describe('User-requested prompt, preserved without silent edits.'),
  referencePaths: z.array(imagePath).min(1).max(7).optional().describe('Local image ingredients in user order: Omni up to 7, image generation or Omni Edit up to 5, Veo ingredients up to 3. Not frame roles.'),
  videoPaths: z.array(videoPath).min(1).max(1).optional().describe('One local MP4/MOV/M4V up to 100 MB and 10s for edit, optionally with up to 5 image ingredients. Duration validated at submission.'),
  startFramePath: imagePath.optional().describe('Start frame role. Required for frames. Never replace with referencePaths or silently swap with endFramePath.'),
  endFramePath: imagePath.optional().describe('End frame role. Requires startFramePath and a model supporting an end frame.'),
  sourceVideoId: text().optional().describe('Existing Flow video media id for extend only, mutually exclusive with ingredients or frames.'),
};
const schemas = {
  status: z.object({}).strict(),
  models: z.object({ kind: z.enum(['image', 'video']).optional(), mode: z.enum(['text', 'references', 'frames', 'extend', 'edit']).optional().describe('Legacy mode; use method for the UI-style input method.'), method: generationMethod.optional(), family: text().optional(), durationSeconds: z.number().int().min(1).max(60).optional(), aspectRatio: text(20).optional(), resolution: text(30).optional(), query: text(300).optional() }).strict(),
  prepare: z.object(generationFields).strict(),
  generate: z.object({
    ...generationFields,
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

function validateGeneration(value, context) {
  const issue = (message, path = []) => context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (Boolean(value.model) === Boolean(value.settings)) issue('Supply exactly one of model or settings.');
  if (value.settings && value.method) issue('method belongs inside settings when using settings.', ['method']);
  const settings = value.settings;
  if (settings) {
    if (settings.kind === 'image' && settings.method !== 'image' || settings.kind === 'video' && settings.method === 'image') issue('kind and method are incompatible.', ['settings', 'method']);
    const timed = settings.kind === 'video' && settings.method !== 'edit';
    if (timed && settings.durationSeconds === undefined) issue('Video settings require durationSeconds.', ['settings', 'durationSeconds']);
    if (!timed && settings.durationSeconds !== undefined) issue('Images and edit must omit durationSeconds; edit follows the source.', ['settings', 'durationSeconds']);
  }
  const sources = Number(Boolean(value.referencePaths || value.videoPaths)) + Number(Boolean(value.startFramePath || value.endFramePath)) + Number(Boolean(value.sourceVideoId));
  if (sources > 1) context.addIssue({ code: z.ZodIssueCode.custom, message: 'References, frame paths, and sourceVideoId are mutually exclusive.' });
  if (value.endFramePath && !value.startFramePath) context.addIssue({ code: z.ZodIssueCode.custom, path: ['startFramePath'], message: 'endFramePath requires startFramePath.' });
  const method = settings?.method || value.method;
  const edit = method === 'edit' || /^omni-1\.[12]-flash-edit-(?:landscape|portrait)(?:-360p)?$/.test(value.model || '');
  if (value.videoPaths && !edit) context.addIssue({ code: z.ZodIssueCode.custom, path: ['videoPaths'], message: 'Only an edit model accepts videoPaths.' });
  if (edit && !value.videoPaths) context.addIssue({ code: z.ZodIssueCode.custom, path: ['videoPaths'], message: 'Edit requires one source video.' });
  if (edit && value.referencePaths?.length > 5) context.addIssue({ code: z.ZodIssueCode.custom, path: ['referencePaths'], message: 'Omni Edit accepts up to 5 image references.' });
  if (method === 'text' && sources) issue('Text accepts no ingredients, frames or sourceVideoId.');
  if (method === 'ingredients' && !value.referencePaths?.length) issue('Ingredients requires at least one referencePaths image.', ['referencePaths']);
  if (['image', 'ingredients'].includes(method) && (value.startFramePath || value.videoPaths || value.sourceVideoId)) issue('This method only accepts image referencePaths.');
  if (method === 'frames' && (!value.startFramePath || value.referencePaths || value.videoPaths || value.sourceVideoId)) issue('Frames requires startFramePath and optional endFramePath only.');
  if (method === 'extend' && (!value.sourceVideoId || sources !== 1)) issue('Extend requires sourceVideoId only.');
}
const generateSchema = schemas.generate.superRefine(validateGeneration);
const prepareSchema = schemas.prepare.superRefine(validateGeneration);

const definitions = [
  ['status', 'status', 'Read app status', 'Read readiness, account summaries, credits, running jobs, and history count. Starts installed Flow Studio if needed.', true, false, true, false],
  ['list_models', 'models', 'List generation models', 'List current exact model ids and supported inputs. For a new video without an explicit choice, prefer compatible Omni 1.2 Flash (preferred:true). Omni 1.1 is not preferred. Catalog presence does not guarantee Google account access. Preserve explicit models; no silent fallback or invented IDs.', true, false, true, true],
  ['prepare_generation', 'prepare', 'Validate generation without spending credits', 'Resolve exact model or separate settings and validate local input files/roles. Does not upload inputs, generate media, create jobs or spend generation credits. Returns generateArguments with exact model and explicit method; add requestId and confirmCreditSpend only for an authorized generation. Does not prove account access, credits, video duration or Google acceptance.', true, false, true, false],
  ['generate', 'generate', 'Generate image or video', 'Spend credits on one user-requested generation, returning jobId immediately. Use either exact model (prefer generateArguments returned by prepare_generation) or separate settings; no model substitution. Set explicit method to distinguish text, ingredients and frame roles. Reuse requestId and exact inputs for retry. Wait then save. Never automatically resubmit failed/cancelled jobs. Edit requires one videoPaths source with optional image ingredients; frame roles use startFramePath/endFramePath; extend uses sourceVideoId.', false, true, true, true],
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
  const parsed = (method === 'generate' ? generateSchema : method === 'prepare' ? prepareSchema : schemas[method]).safeParse(params);
  if (!parsed.success) throw new BridgeError('INVALID_ARGUMENTS', parsed.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
  return client.call(method, parsed.data, options);
}

function createServer(client = new BridgeClient()) {
  const server = new McpServer({ name: 'flow-studio', version: '1.2.0' }, {
    instructions: 'Control Flow Studio through its local bridge. For new video without an explicit model choice, prefer compatible Omni 1.2 Flash from the live catalog; Omni 1.1 is not preferred. Preserve explicit model IDs, saved selections and history. If compatible 1.2 is unavailable, report it without silent fallback; never invent IDs. Read status and list_models. Use prepare_generation to check separate settings and frame/ingredient roles without upload or credit spend; it returns exact generateArguments. Generate only when authorized, with a stable requestId and confirmCreditSpend:true; then wait and save. Never silently change model, settings, prompt or inputs after failure. Engine runs only while the app is open; stop polling when the user closes it to stop work. Never reveal credentials.',
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
