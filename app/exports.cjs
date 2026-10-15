'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

async function saveWithDialog({ runtime, window, dialog, downloadsDir }, input) {
  const job = runtime.jobs.find(item => item.id === input?.jobId);
  const index = input?.index;
  if (!job || !Number.isInteger(index) || index < 0 || !job.media?.[index]) throw new Error('Результат не найден.');
  const media = job.media[index];
  const extension = media.path ? path.extname(media.path) : media.kind === 'video' ? '.mp4' : media.url?.startsWith('data:image/jpeg') ? '.jpg' : '.png';
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: 'Сохранить результат',
    defaultPath: media.savedPath || path.join(downloadsDir, 'Flow-' + (job.createdAt || job.id).replace(/[:.]/g, '-') + extension)
  });
  if (canceled || !filePath) return null;
  if (!media.path) media.path = await runtime.cacheMedia(job.id, index, media);
  await fs.copyFile(media.path, filePath);
  media.savedPath = filePath;
  await runtime.persist();
  runtime.emitJob(job);
  return { path: filePath };
}

async function revealSaved({ runtime, shell }, file) {
  if (typeof file !== 'string' || !file || !runtime.jobs.some(job => job.media?.some(media => media.savedPath === file))) throw new Error('Сохранённый файл не найден.');
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error('Сохранённый файл не найден. Сохраните результат заново.');
  shell.showItemInFolder(file);
}

module.exports = { saveWithDialog, revealSaved };
