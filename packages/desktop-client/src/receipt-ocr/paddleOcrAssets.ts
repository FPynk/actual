const paddleOcrAssetRoot = '/paddleocr';

export const paddleOcrCreateOptions = {
  textDetectionModelName: 'PP-OCRv5_mobile_det',
  textDetectionModelAsset: {
    url: `${paddleOcrAssetRoot}/models/PP-OCRv5_mobile_det_onnx_infer.tar`,
  },
  textRecognitionModelName: 'PP-OCRv5_mobile_rec',
  textRecognitionModelAsset: {
    url: `${paddleOcrAssetRoot}/models/PP-OCRv5_mobile_rec_onnx_infer.tar`,
  },
  ortOptions: {
    backend: 'wasm',
    wasmPaths: `${paddleOcrAssetRoot}/onnxruntime/`,
    numThreads: 1,
    simd: true,
  },
} as const;
