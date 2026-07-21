import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
MANIFEST = json.loads((ROOT / "model-manifest.json").read_text(encoding="utf-8"))
WORKFLOW_PATH = ROOT.parents[1] / "config" / "ai-workflows" / "z-image-turbo.json"
WORKFLOW_SOURCE = WORKFLOW_PATH.read_text(encoding="utf-8")
WORKFLOW = json.loads(WORKFLOW_SOURCE)


class ModelManifestTest(unittest.TestCase):
    def test_worker_image_is_pinned(self):
        worker = MANIFEST["worker"]
        self.assertIn(f'runpod/worker-comfyui:{worker["release"]}-base@{worker["baseImageDigest"]}', DOCKERFILE)

    def test_every_model_file_is_pinned_and_checked(self):
        revision = MANIFEST["model"]["revision"]
        self.assertIn(f"ARG Z_IMAGE_MODEL_REVISION={revision}", DOCKERFILE)
        for item in MANIFEST["model"]["files"]:
            self.assertGreater(item["size"], 0)
            self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$")
            self.assertIn(item["path"].split("/")[-1], DOCKERFILE)
            self.assertIn(item["sha256"], DOCKERFILE)

    def test_expected_bundle_size_is_recorded(self):
        total = sum(item["size"] for item in MANIFEST["model"]["files"])
        self.assertEqual(total, 20_690_152_836)

    def test_workflow_uses_only_core_z_image_nodes(self):
        expected_types = {
            "UNETLoader",
            "CLIPLoader",
            "VAELoader",
            "CLIPTextEncode",
            "ConditioningZeroOut",
            "EmptySD3LatentImage",
            "ModelSamplingAuraFlow",
            "KSampler",
            "VAEDecode",
            "SaveImage",
        }
        self.assertEqual({node["class_type"] for node in WORKFLOW.values()}, expected_types)
        self.assertEqual(WORKFLOW["8"]["inputs"]["steps"], 8)
        self.assertEqual(WORKFLOW["8"]["inputs"]["cfg"], 1)
        self.assertEqual(WORKFLOW["8"]["inputs"]["sampler_name"], "res_multistep")
        self.assertEqual(WORKFLOW["7"]["inputs"]["shift"], 3)

    def test_workflow_has_the_complete_scalar_contract(self):
        for token in ("{{PROMPT}}", "{{NEGATIVE_PROMPT}}", "{{WIDTH}}", "{{HEIGHT}}", "{{SEED}}"):
            self.assertIn(token, WORKFLOW_SOURCE)
        self.assertEqual(WORKFLOW["1"]["inputs"]["unet_name"], "z_image_turbo_bf16.safetensors")
        self.assertEqual(WORKFLOW["2"]["inputs"]["clip_name"], "qwen_3_4b.safetensors")
        self.assertEqual(WORKFLOW["3"]["inputs"]["vae_name"], "ae.safetensors")


if __name__ == "__main__":
    unittest.main()
