"""Independent formula-only comparison using identical, manually checked crop inputs.

Pix2Text follows its published ONNX model card: DeiT preprocessing + greedy TrOCR.
No remote inference, new packages, or source-question edits are involved.
"""
import argparse
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backend', choices=['pix2text', 'mineru-formula'], required=True)
    parser.add_argument('--project', type=Path, required=True)
    args = parser.parse_args()
    work = args.project/'experiments/document-pipeline/work'
    cases = json.loads((work/'samples/formula-cases.json').read_text(encoding='utf8'))
    loaded = time.monotonic()
    if args.backend == 'pix2text':
        import onnxruntime as ort
        from tokenizers import Tokenizer
        model = args.project/'.tools/document-pipeline/models/pix2text-mfr-1.5'
        config = json.loads((model/'config.json').read_text())
        preprocessing = json.loads((model/'preprocessor_config.json').read_text())
        generation = json.loads((model/'generation_config.json').read_text())
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        encoder = ort.InferenceSession(str(model/'encoder_model.onnx'), options, providers=['CPUExecutionProvider'])
        decoder = ort.InferenceSession(str(model/'decoder_model.onnx'), options, providers=['CPUExecutionProvider'])
        tokenizer = Tokenizer.from_file(str(model/'tokenizer.json'))
        input_description = {'encoder': [value.name for value in encoder.get_inputs()],
                             'decoder': [value.name for value in decoder.get_inputs()]}
        print(json.dumps(input_description), flush=True)
        def recognize(path):
            image = Image.open(path).convert('RGB').resize(
                (preprocessing['size']['width'], preprocessing['size']['height']), Image.Resampling(preprocessing['resample']))
            pixels = np.asarray(image, dtype=np.float32)*preprocessing['rescale_factor']
            pixels = (pixels-np.asarray(preprocessing['image_mean'], dtype=np.float32))/np.asarray(preprocessing['image_std'], dtype=np.float32)
            encoded = encoder.run(None, {encoder.get_inputs()[0].name: pixels.transpose(2,0,1)[None]})[0]
            tokens = [config['decoder_start_token_id']]
            complete = False
            for _ in range(generation['max_new_tokens']):
                feed = {'input_ids': np.asarray([tokens], dtype=np.int64), 'encoder_hidden_states': encoded}
                for value in decoder.get_inputs():
                    if value.name not in feed:
                        raise RuntimeError(f'Unhandled ONNX decoder input: {value.name}')
                logits = decoder.run(None, feed)[0]
                token = int(np.argmax(logits[0,-1]))
                tokens.append(token)
                if token == config['eos_token_id']:
                    complete = True
                    break
            return {'latex': tokenizer.decode(tokens, skip_special_tokens=True), 'complete': complete, 'tokens': len(tokens)}
    else:
        from mineru.model.mfr import pp_formulanet_plus_m_onnx as formula
        formula.CPU_BATCH_SIZE = 1
        folder = args.project/'.tools/document-pipeline/cache/mineru/models/MinerU-4_models_onnx/MFR/pp_formulanet_plus_m'
        engine = formula.PPFormulaNetPlusMONNX(str(folder/'PP-FormulaNet_plus-M.onnx'),
                                              str(folder/'PP-FormulaNet_plus-M_inference.yml'), 'cpu', 2)
        def recognize(path):
            # MinerU's original pipeline passes BGR (OpenCV) images to the formula model.
            image = np.asarray(Image.open(path).convert('RGB'))[:,:,::-1]
            return {'latex': engine._infer_batch([image], batch_size=1)[0], 'complete': None}
    load_seconds = time.monotonic()-loaded
    rows = []
    for case in cases:
        started = time.monotonic()
        result = recognize(work/'samples'/case['image'])
        row = {'id': case['id'], 'reference': case['reference'], **result,
               'seconds': round(time.monotonic()-started, 3)}
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    output = {'backend': args.backend, 'model_load_seconds': round(load_seconds, 3),
              'sampling': 'greedy' if args.backend == 'pix2text' else 'upstream baked ONNX decoder',
              'same_crop_inputs': True, 'uploaded_images': 0, 'results': rows}
    (work/'results'/f'formula-{args.backend}.json').write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
