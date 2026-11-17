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
  accountId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe('Optional exact active account id from list_accounts. Omit to select one eligible account once. The chosen account stays pinned; errors never rotate accounts.'),
  prompt: text(20000).describe('User-requested prompt, preserved without silent edits.'),
  referencePaths: z.array(imagePath).min(1).max(7).optional().describe('Local image ingredients in user order: Omni up to 7, image generation or Omni Edit up to 5, Veo ingredients up to 3. Not frame roles.'),
  videoPaths: z.array(videoPath).min(1).max(1).optional().describe('One local MP4/MOV/M4V up to 100 MiB for edit, optionally with up to 5 image ingredients. Read fileLimits.video.maxDurationSeconds from list_models: Omni 1.2 Edit allows 15s; Omni 1.1 Edit allows 10s. For current Omni 1.2 browser Edit, source dimensions must match the selected mode exactly: 360x640 or 640x360 at 360p; 720x1280 or 1280x720 at standard 720p. No automatic resizing. Default local preparation does not inspect duration or geometry; browser checking and submission validate both before upload.'),
  startFramePath: imagePath.optional().describe('Start frame role. Required for frames. Never replace with referencePaths or silently swap with endFramePath.'),
  endFramePath: imagePath.optional().describe('End frame role. Requires startFramePath and a model supporting an end frame.'),
  sourceVideoId: text().optional().describe('Existing Flow video media id for extend only, mutually exclusive with ingredients or frames.'),
};
const schemas = {
  status: z.object({}).strict(),
  models: z.object({ kind: z.enum(['image', 'video']).optional(), mode: z.enum(['text', 'references', 'frames', 'extend', 'edit']).optional().describe('Legacy mode; use method for the UI-style input method.'), method: generationMethod.optional(), family: text().optional(), durationSeconds: z.number().int().min(1).max(60).optional(), aspectRatio: text(20).optional(), resolution: text(30).optional(), query: text(300).optional() }).strict(),
  prepare: z.object({...generationFields,checkBrowser:z.boolean().optional().describe('Default false: local validation only. True requires accountId and a supported Nano Banana, Omni 1.2 or standard Veo 3.1 model; opens its managed background browser, uploads requested image ingredients, explicit start/end frames or one source video for edit to Google, verifies prompt/settings, clears owned composer and releases browser. Never clicks Generate or spends generation credits. Do not automatically retry. Absent from returned generateArguments.')}).strict(),
  generate: z.object({
    ...generationFields,
    confirmCreditSpend: z.literal(true).describe('Set true only when user requested this generation. That request authorizes credit spend; do not ask redundantly.'),
    requestId: text(128).describe('Unique stable id for this intended generation. Reuse the same id and exact inputs on a retry; use a new id only for a new user-requested generation.'),
  }).strict(),
  job: z.object({ jobId }).strict(),
  recover: z.object({ jobId }).strict(),
  wait: z.object({ jobId, timeoutSeconds: z.number().min(0).max(30).optional() }).strict(),
  history: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(),
  save: z.object({ jobId, index, outputPath: absolutePath, overwrite: z.boolean().optional().describe('Default false. Set true only when user explicitly authorized replacing that file.') }).strict(),
  open_folder: z.object({ jobId, index }).strict(),
  accounts: z.object({}).strict(),
  set_account_active:z.object({accountId:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),enabled:z.boolean()}).strict(),
  check_account:z.object({accountId:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)}).strict(),
  check_enabled_accounts:z.object({}).strict(),
  reset_cooldown:z.object({accountId:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)}).strict(),
  isolated_inspect: z.object({ accountId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
  native_inspect: z.object({ accountId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
  native_prepare: z.object({
    accountId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    model: text().refine(value => /^omni-1\.2-flash-([3-9]|1[0-5])s-(landscape|portrait)(-360p)?$/.test(value), 'Use an exact native Omni 1.2 Flash model id').describe('Exact native Omni 1.2 Flash model id, including duration and aspect ratio; no aliases or fallback.'),
    prompt: text(20000).refine(value => !value.includes('\0'), 'NUL is not allowed').describe('Exact user prompt, preserved unchanged.'),
    referencePaths: z.array(imagePath.refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Control characters are not allowed')).max(7).describe('Up to seven absolute local image paths in user order; [] for text. No videos or frame roles.'),
  }).strict(),
  native_submit: z.object({ token: text(128), confirmCreditSpend: z.literal(true).describe('True only for the authorized prepared generation. Submission consumes this token once; never automatically retry.') }).strict(),
  native_cancel: z.object({}).strict(),
  login_start: z.object({ accountId: z.number().int().min(1).optional() }).strict(),
  login_complete: z.object({}).strict(),
  login_cancel: z.object({}).strict(),
  cancel: z.object({ jobId }).strict(),
};

function validateGeneration(value, context) {
  const issue = (message, path = []) => context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (Boolean(value.model) === Boolean(value.settings)) issue('Supply exactly one of model or settings.');
  if(value.checkBrowser===true&&value.accountId===undefined)issue('checkBrowser requires explicit accountId.',['accountId']);
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
  ['status', 'status', 'Read app status', 'Read readiness, API features, account summaries, credits, running jobs, and history count. Supported Nano Banana, Omni 1.2 Flash and standard Veo 3.1 models generate automatically in an isolated background browser. Starts installed Flow Studio if needed.', true, false, true, false],
  ['list_models', 'models', 'List generation models', 'List current exact model ids, supported inputs, and generationEngine (isolated-browser or server). For a new video without an explicit choice, prefer compatible Omni 1.2 Flash (preferred:true). Omni 1.1 is not preferred. Catalog presence does not guarantee Google account access. Preserve explicit models; no silent fallback or invented IDs.', true, false, true, true],
  ['prepare_generation', 'prepare', 'Prepare generation without spending credits', 'Resolve exact model or separate settings and validate local input files/roles. Default checkBrowser:false performs local validation only: no uploads, browser changes, jobs or spend. Optional checkBrowser:true requires explicit accountId and a supported Nano Banana, Omni 1.2 or Veo 3.1 model; uploads requested images, explicit frame roles or an edit source video to Google in the managed background browser, verifies exact inputs/settings, then clears owned composer and releases browser. Never clicks Generate, creates jobs or spends generation credits. Browser checks never automatically retry. Returns checks.browser/upload and browserCheck on success; generateArguments never contains checkBrowser. Add requestId and confirmCreditSpend only for an authorized generation. Does not prove credits, video duration or Google generation acceptance.', false, false, false, true],
  ['generate', 'generate', 'Generate image or video', 'Spend credits on one user-requested generation, returning jobId immediately. Supported Nano Banana, Omni 1.2 Flash and standard Veo 3.1 models automatically use an isolated background browser without desktop focus; no separate browser preparation is needed. Other models use their catalog generationEngine. Optional accountId pins one active account; failures never rotate accounts or fall back to another engine. Use either exact model (prefer generateArguments returned by prepare_generation) or separate settings; no model substitution. Set explicit method to distinguish text, ingredients and frame roles. Reuse requestId and exact inputs for retry. Wait then save. Never automatically resubmit failed/cancelled jobs. Edit requires one videoPaths source with optional image ingredients; frame roles use startFramePath/endFramePath; extend uses sourceVideoId.', false, true, true, true],
  ['get_job', 'job', 'Read generation job', 'Read job status and returned media localPath/url/savedPath. No authentication data is returned.', true, false, true, false],
  ['recover_job', 'recover', 'Check existing unknown generation result', 'Recover one existing isolated-browser job with unknown outcome using its durable submission receipt. Reads the pinned account/project and binds exact full prompt text, ordered ingredients and matching output poster to one selected semantic History entry. Edit also binds the original source scene and its typed image preview; that preview is not a Google video ID. Rechecks that tuple before using only the entry’s own button and aria-controlled download menus. Missing, ambiguous or changed ownership fails closed. It may scroll the loaded app-owned project grid to reveal an existing candidate. Never uploads inputs, sends Agent messages, clicks Generate or Approve, creates a new job or spends generation credits. Requires jobId only; no credit confirmation or new requestId. Missing receipt fails clearly. Returns existing jobId immediately; wait for that job. Never automatically resubmit or switch accounts.', false, false, false, true],
  ['wait_job', 'wait', 'Wait for generation job', 'Wait up to 30 seconds for a job; returns {job, done}. Repeat bounded waits while unfinished. Timeout does not start another job.', true, false, true, false],
  ['list_jobs', 'history', 'Read recent jobs', 'List persisted generation jobs, newest first, including saved result paths.', true, false, true, false],
  ['save_result', 'save', 'Save generated media', 'Save a selected result to an explicit absolute outputPath. Parent directory must exist. Refuses existing files unless overwrite is explicitly true.', false, true, false, false],
  ['open_result_folder', 'open_folder', 'Reveal generated media', 'Reveal saved result, or local cached result, in Finder.', false, false, true, false],
  ['list_accounts', 'accounts', 'List Google accounts', 'Read account ids, email, credit balance, and active status. Returns no cookies, tokens, or credentials.', true, false, true, true],
  ['set_account_active','set_account_active','Set account generation participation','Explicitly enable or disable one exact accountId for new generations using enabled:true or false. Refreshes confirmed backend state. Does not clear cooldown, change Google restrictions, reconnect, or start generation. Never enable an account automatically after failure.',false,false,false,false],
  ['check_account','check_account','Check saved account connection','Check the saved Google Flow session for one exact accountId and verify the returned identity. Does not enable the account, clear cooldown, or generate media. Reports the original error if verification fails; no automatic retry or account switching.',false,false,false,true],
  ['check_enabled_accounts','check_enabled_accounts','Check all enabled account connections','Serially synchronize each enabled managed account and verify its saved Flow session through the same app action as the Accounts button. Disabled accounts are skipped; a failure is reported for that account and does not stop the remaining checks. Returns total/checked/verified/failed/skipped and per-account results. Never enables accounts, resets cooldowns, uploads inputs or generates media. Requires empty arguments; no automatic retry.',false,false,false,true],
  ['reset_account_cooldown','reset_cooldown','Reset local account cooldown','Explicitly clear the selected account’s app-local 30-minute cooldown for any error, including PUBLIC_ERROR_UNUSUAL_ACTIVITY. Requires exact accountId from list_accounts. Preserves manual disabled state and last error, changes no Google limits, uploads nothing and never starts generation. Use only for a requested manual reset; never reset or retry automatically after a generation error.',false,false,false,false],
  ['inspect_isolated_browser', 'isolated_inspect', 'Inspect isolated background browser', 'Read readiness, verified account, and project for one active account in the app-owned isolated background browser without desktop focus. Does not upload inputs, click Generate, create jobs, or spend generation credits. Never automatically retry browser errors.', true, false, false, true],
  ['inspect_browser', 'native_inspect', 'Inspect selected Chrome browser', 'Legacy diagnostic action: read the Flow editor for one known active account. Opens or focuses its selected Chrome browser; account verification may open and close the account drawer only. Standard generate automatically uses an isolated background browser for supported Omni 1.2 text and ingredients. Does not upload files, prepare generation, click Generate, create jobs, or spend credits.', true, false, false, true],
  ['prepare_browser', 'native_prepare', 'Prepare native Chrome generation', 'Legacy diagnostic action for exact Omni 1.2 Flash text or image ingredients only. Standard generate already handles supported Omni 1.2 generations in an isolated background browser. This diagnostic action opens or focuses Chrome, verifies account and settings, fills the exact prompt, and uploads requested local image references. Returns a one-use token after verifying attachments. Does not click Generate or spend generation credits. Preparation changes the browser; never automatically retry. No videos, frame roles, model substitution, or fallback.', false, false, false, true],
  ['submit_browser', 'native_submit', 'Submit prepared native generation once', 'Legacy diagnostic action: spend credits for the authorized native browser preparation using its token and confirmCreditSpend:true. Standard generate handles the isolated background route automatically. This action persists an outcome-unknown record before one Generate click and consumes the token. No requestId is needed. Never automatically retry or prepare another token after an ambiguous result; inspect the open Flow project first.', false, true, false, true],
  ['cancel_browser_preparation', 'native_cancel', 'Cancel native browser preparation', 'Release the current native preparation and delete its private staged references. Invalidates its one-use token without clicking Generate or cancelling an already submitted Google job. Never automatically retry.', false, false, true, false],
  ['begin_google_login', 'login_start', 'Begin Google sign-in', 'Open human Google sign-in flow. User enters credentials in browser; never request passwords or cookies. Optional accountId reauthenticates an existing account.', false, false, false, true],
  ['complete_google_login', 'login_complete', 'Finish Google sign-in', 'Finish sign-in after user completes the browser flow; save account privately in Flow Studio.', false, false, false, true],
  ['cancel_google_login', 'login_cancel', 'Cancel Google sign-in', 'Close the pending Google sign-in flow.', false, false, true, false],
  ['cancel_job', 'cancel', 'Cancel generation job', 'Cancel app waiting through the shared runtime. Job remains running until its engine settles. Before submission, no request is sent; after submission, Google may still finish generation or charge credits and outcome can remain unknown. Do not automatically resubmit.', false, true, true, true],
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
  const server = new McpServer({ name: 'flow-studio', version: '1.3.0' }, {
    instructions: 'Control Flow Studio through its local bridge. For new video without an explicit model choice, prefer compatible Omni 1.2 Flash from the live catalog; Omni 1.1 is not preferred. Supported Nano Banana image models, standard Veo 3.1 and Omni 1.2 text, ingredients, frames and edit use the catalog isolated-browser route without desktop focus; diagnostic browser tools are optional legacy actions. Omni 1.2 Edit uses Flow Agent with one proposal and one Approve. Verified cases are portrait 720p with two ordered images and portrait 360p without image references; downloaded dimensions and source duration are checked. Recovery binds exact full prompt, ordered references and output poster to one selected History entry, rechecking ownership before its own aria-controlled download menus. Edit recovery also binds the original source scene and typed image preview. After an eligible observation error on a submitted job, the app releases its lease and resumes reading that same receipt once, without uploads, Agent messages, a new proposal or Approve; cancellation, confirmed rejection or a mismatched receipt blocks this transition. Read generationEngine in list_models for each route. Preserve explicit model IDs, saved selections and history. If compatible 1.2 is unavailable, report it without silent fallback; never invent IDs. Read status and list_models. prepare_generation defaults to local settings/file validation without upload or credit spend; it returns exact generateArguments and preserves optional accountId. Only for a requested browser/upload check, add checkBrowser:true with explicit accountId: images upload to Google, settings verify, owned composer clears and browser releases, without Generate click or job. Do not automatically retry browser checks. generateArguments omits checkBrowser and generate rejects it. Generate only when authorized, with a stable requestId and confirmCreditSpend:true; then wait and save. Chosen accounts stay pinned; never rotate accounts, fall back to another engine, or silently change model, settings, prompt or inputs after failure. Engine runs only while the app is open; stop polling when the user closes it to stop work. Never reveal credentials.',
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
