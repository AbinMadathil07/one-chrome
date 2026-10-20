import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';

const DOCUMENT_ID_PATTERN = /^[\w][\w.-]{0,199}$/;

async function resolveInside(path: string, label: string, uploadDir: string | null): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new Error(`File not found or unreadable: ${label}`);
  }
  if (uploadDir) {
    const root = await realpath(uploadDir).catch(() => {
      throw new Error(`Upload directory ${uploadDir} does not exist`);
    });
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
      throw new Error(`Upload refused: ${label} is outside the allowed upload directory.`);
    }
  }
  const info = await stat(real);
  if (!info.isFile()) {
    throw new Error(`Upload refused: ${label} is not a regular file.`);
  }
  return real;
}

/**
 * Resolves upload paths (following symlinks and `..`) and staged document ids to real files.
 * With an upload directory configured, nothing outside it is accepted.
 */
export async function resolveUploadFiles(
  paths: string[],
  documentIds: string[],
  uploadDir: string | null,
): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw new Error(`Upload paths must be absolute: ${path}`);
    }
    files.push(await resolveInside(path, path, uploadDir));
  }
  for (const id of documentIds) {
    if (!uploadDir) {
      throw new Error('document_ids need CHROME_MCP_UPLOAD_DIR, the directory staged documents are read from.');
    }
    if (!DOCUMENT_ID_PATTERN.test(id) || id.includes('..')) {
      throw new Error(`Invalid document_id ${JSON.stringify(id)}; use a file name staged in the upload directory.`);
    }
    files.push(await resolveInside(join(uploadDir, id), `document ${id}`, uploadDir));
  }
  return files;
}
