import path from 'node:path';

const allowedAssetDirectories = new Set(['paddleocr', 'static']);

function isPathWithinDirectory(filePath: string, directoryPath: string) {
  const relativePath = path.relative(directoryPath, filePath);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath)
  );
}

export function resolveClientBuildAssetPath(
  clientBuildPath: string,
  pathname: string,
) {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const [, assetDirectory, ...assetPathSegments] = decodedPathname.split('/');
  if (
    !allowedAssetDirectories.has(assetDirectory) ||
    !assetPathSegments.length
  ) {
    return null;
  }

  const assetDirectoryPath = path.resolve(clientBuildPath, assetDirectory);
  const assetPath = path.resolve(assetDirectoryPath, ...assetPathSegments);
  return isPathWithinDirectory(assetPath, assetDirectoryPath)
    ? assetPath
    : null;
}
