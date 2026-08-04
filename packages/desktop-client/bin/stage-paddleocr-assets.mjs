import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const publicPaddleOcrDir = path.join(packageRoot, 'public', 'paddleocr');
const modelDir = path.join(publicPaddleOcrDir, 'models');
const onnxRuntimeDir = path.join(publicPaddleOcrDir, 'onnxruntime');

const paddleOcrModels = [
  {
    fileName: 'PP-OCRv5_mobile_det_onnx_infer.tar',
    sha256: '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30',
    url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar',
  },
  {
    fileName: 'PP-OCRv5_mobile_rec_onnx_infer.tar',
    sha256: 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c',
    url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar',
  },
];
const onnxRuntimeFiles = [
  {
    fileName: 'ort-wasm-simd-threaded.jsep.mjs',
    sha256: '3ee381d20a80f51a788a1c4a5872f6f1d047538dd4342f4af00062de5f9ea4c6',
  },
  {
    fileName: 'ort-wasm-simd-threaded.jsep.wasm',
    sha256: '78feeeb3d08f6bcee94d938ed322f69073bb8076b5f9d34697a574ffba8deb48',
  },
];

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fileMatchesHash(filePath, expectedHash) {
  return (
    (await fileExists(filePath)) &&
    hash(await readFile(filePath)) === expectedHash
  );
}

async function writeVerifiedFile(destination, contents, expectedHash) {
  const temporaryFile = `${destination}.${process.pid}.download`;
  await rm(temporaryFile, { force: true });
  await writeFile(temporaryFile, contents);

  if (!(await fileMatchesHash(temporaryFile, expectedHash))) {
    await rm(temporaryFile, { force: true });
    throw new Error(
      `The downloaded ${path.basename(destination)} did not match its pinned SHA-256. Run \`yarn workspace @actual-app/web stage:paddleocr-assets\` to retry.`,
    );
  }

  await rename(temporaryFile, destination);
}

async function downloadModel({ fileName, sha256, url }) {
  const destination = path.join(modelDir, fileName);
  if (await fileMatchesHash(destination, sha256)) return;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not download ${fileName}: ${response.status} ${response.statusText}. Run \`yarn workspace @actual-app/web stage:paddleocr-assets\` after restoring network access.`,
    );
  }

  await writeVerifiedFile(
    destination,
    new Uint8Array(await response.arrayBuffer()),
    sha256,
  );
}

export async function stagePaddleOcrAssets() {
  await mkdir(modelDir, { recursive: true });
  await mkdir(onnxRuntimeDir, { recursive: true });
  await Promise.all(paddleOcrModels.map(downloadModel));

  const onnxRuntimeDistDir = path.dirname(require.resolve('onnxruntime-web'));
  for (const onnxRuntimeFile of onnxRuntimeFiles) {
    const onnxRuntimeSource = path.join(
      onnxRuntimeDistDir,
      onnxRuntimeFile.fileName,
    );
    if (!(await fileMatchesHash(onnxRuntimeSource, onnxRuntimeFile.sha256))) {
      throw new Error(
        `The installed ${onnxRuntimeFile.fileName} did not match its pinned SHA-256. Run \`yarn install\` to restore the lockfile version.`,
      );
    }

    const onnxRuntimeDestination = path.join(
      onnxRuntimeDir,
      onnxRuntimeFile.fileName,
    );
    if (
      !(await fileMatchesHash(onnxRuntimeDestination, onnxRuntimeFile.sha256))
    ) {
      await writeVerifiedFile(
        onnxRuntimeDestination,
        await readFile(onnxRuntimeSource),
        onnxRuntimeFile.sha256,
      );
    }
  }

  await rm(path.join(onnxRuntimeDir, 'ort-wasm-simd-threaded.wasm'), {
    force: true,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await stagePaddleOcrAssets();
}
