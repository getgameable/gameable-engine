"""Build a neutral GNM model head for an internal prototype (numpy only).

Unlike a fitted BakedHead, this uses the source model's mean identity. The head
is rigidly attached to the body's head bone by the host; eye skinning remains
inside the GNM rig. Source-model licensing still applies to the output.

Usage: python gnm_neutral_pack.py --model gnm_head.npz --out head.e64.aosrig
"""
import argparse
import json
from pathlib import Path
import tempfile
import numpy as np
from gnm_pack import build


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    model = np.load(args.model, allow_pickle=False)
    names = list(model['joint_names'])
    neutral = model['template_vertex_positions']
    count = len(neutral)
    eyes = [names.index('left_eye'), names.index('right_eye')]
    with tempfile.TemporaryDirectory() as temp:
        head = Path(temp) / 'neutral.head.npz'
        rig = Path(temp) / 'neutral.aosrig'
        weights = np.zeros((count, 4), np.float32)
        weights[:, 0] = 1
        np.savez(head, neutral=neutral, basis=model['expression_basis'],
                 faces=model['triangles'], eye_names=np.array(['left_eye', 'right_eye']),
                 eye_positions=model['template_joint_positions'][eyes],
                 eye_weights=model['skinning_weights'][eyes],
                 skin_index=np.zeros((count, 4), np.uint16), skin_weight=weights)
        Path(str(rig) + '.json').write_text(json.dumps({
            'joints': [{'name': 'head', 'parent': None}],
            'head': {'attachment': {'local_to_head': np.eye(4).tolist()}}
        }))
        np.savez(str(rig) + '.npz', bind_world=np.eye(4)[None])
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(build(head, rig, None, trunc_exp=64, lean=True))
        print(f'{count} vertices, 64 expression coefficients: {args.out}')


if __name__ == '__main__':
    main()
