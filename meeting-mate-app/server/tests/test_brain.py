import os
import sys
import unittest


SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from brain import extract_actions


class ExtractActionsTests(unittest.TestCase):
    def test_create_task_action_shape(self):
        result = {
            "success": True,
            "task": {
                "title": "Write tests",
                "assignee": "Alice",
                "due_date": "2026-03-20",
                "priority": "high",
            },
        }

        actions = extract_actions("create_task", result)

        self.assertEqual(
            actions,
            [
                {
                    "action": "create_task",
                    "data": {
                        "title": "Write tests",
                        "assignee": "Alice",
                        "due_date": "2026-03-20",
                        "priority": "high",
                    },
                }
            ],
        )

    def test_generate_diagram_action_includes_mermaid_code_description_and_title(self):
        result = {
            "success": True,
            "mermaid_code": "graph TD\nA --> B",
            "description": "Project flow",
            "title": "概要図: Project flow",
        }

        actions = extract_actions("generate_diagram", result)

        self.assertEqual(
            actions,
            [
                {
                    "action": "generate_diagram",
                    "data": {
                        "mermaid_code": "graph TD\nA --> B",
                        "description": "Project flow",
                        "title": "概要図: Project flow",
                    },
                }
            ],
        )

    def test_generate_diagram_failure_returns_no_actions(self):
        self.assertEqual(
            extract_actions("generate_diagram", {"success": False}),
            [],
        )


if __name__ == "__main__":
    unittest.main()
