import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('boundary', Path(__file__).parents[1] / 'apply-read-only-boundary.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class BoundaryTests(unittest.TestCase):
    def test_preserves_rules_and_is_idempotent(self):
        original = {'mode':'enforce', 'deny':['bot.id == "other"'], 'allow':['true']}
        result = module.merge_policy(original)
        self.assertEqual(result['allow'], original['allow'])
        self.assertEqual(result['deny'][0], original['deny'][0])
        self.assertEqual(module.merge_policy(result), result)
        self.assertEqual(len(original['deny']), 1)
    def test_migrates_only_the_exact_previous_boundary(self):
        old = module.BOUNDARY['previousDeny'][0]
        custom = "bot.id == 'onyx'"
        original = {'mode':'enforce', 'deny':[old, custom], 'allow':['true']}
        result = module.merge_policy(original)
        self.assertNotIn(old, result['deny'])
        self.assertIn(custom, result['deny'])
        self.assertIn(module.BOUNDARY['deny'], result['deny'])
        self.assertEqual(original['deny'], [old, custom])
    def test_dry_run_refused(self):
        with self.assertRaises(ValueError):
            module.merge_policy({'mode':'dry-run', 'deny':[], 'allow':['true']})
if __name__ == '__main__':
    unittest.main()
