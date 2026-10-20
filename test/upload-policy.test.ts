import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveUploadFiles } from '../src/browser/upload-policy.js';

describe('resolveUploadFiles', () => {
  it('accepts files inside the upload dir and rejects escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chrome-mcp-upload-'));
    const uploads = join(root, 'uploads');
    await mkdir(uploads);
    await writeFile(join(uploads, 'ok.txt'), 'ok');
    await writeFile(join(root, 'secret.txt'), 'secret');
    await symlink(join(root, 'secret.txt'), join(uploads, 'link.txt'));

    const [ok] = await resolveUploadFiles([join(uploads, 'ok.txt')], [], uploads);
    assert.ok(ok?.endsWith('ok.txt'));
    assert.equal((await resolveUploadFiles([], ['ok.txt'], uploads)).length, 1);

    await assert.rejects(resolveUploadFiles([join(uploads, '..', 'secret.txt')], [], uploads), /outside the allowed upload directory/);
    await assert.rejects(resolveUploadFiles([join(uploads, 'link.txt')], [], uploads), /outside the allowed upload directory/);
    await assert.rejects(resolveUploadFiles([], ['../secret.txt'], uploads), /Invalid document_id/);
    await assert.rejects(resolveUploadFiles(['relative.txt'], [], uploads), /must be absolute/);
    await assert.rejects(resolveUploadFiles([], ['ok.txt'], null), /CHROME_MCP_UPLOAD_DIR/);
    await assert.rejects(resolveUploadFiles([uploads], [], null), /not a regular file/);
  });
});
