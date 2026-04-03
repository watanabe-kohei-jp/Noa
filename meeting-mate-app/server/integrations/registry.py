"""
Tool Registry — ツール定義・権限・ハンドラの一元管理

全ツールを Registry に登録し、TOOL_SELECTION_PROMPT / FOLLOW_UP_ALLOWED_TOOLS /
execute_tool() のディスパッチを自動導出する。
"""
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)


@dataclass
class ToolDefinition:
    """ツール定義"""
    name: str
    description: str
    args_description: str
    handler: Callable[..., Awaitable[dict[str, Any]]]
    read_only: bool = True
    follow_up_allowed: bool = True
    requires_confirmation: bool = False
    principal_scope: str = "none"  # none | user | workspace


class ToolRegistry:
    """ツールの登録・検索・実行・プロンプト生成を一元管理"""

    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, tool: ToolDefinition) -> None:
        if tool.name in self._tools:
            logger.warning(f"Tool '{tool.name}' is already registered, overwriting")
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    async def execute(self, name: str, args: dict, meeting_context: dict) -> dict:
        tool = self._tools.get(name)
        if tool is None:
            return {"error": f"Unknown tool: {name}"}
        return await tool.handler(args, meeting_context)

    def build_tool_prompt(self) -> str:
        """TOOL_SELECTION_PROMPT のツール一覧部分を動的生成"""
        lines = []
        for tool in self._tools.values():
            lines.append(f"- {tool.name}: {tool.description}")
            lines.append(f"  args: {tool.args_description}")
            lines.append("")
        return "\n".join(lines).rstrip()

    def get_follow_up_allowed(self) -> set[str]:
        return {name for name, t in self._tools.items() if t.follow_up_allowed}

    def get_follow_up_prompt_tools(self) -> str:
        """FOLLOW_UP_PROMPT の利用可能ツール列挙"""
        return ", ".join(self._tools.keys())

    @property
    def tool_names(self) -> list[str]:
        return list(self._tools.keys())


# グローバルレジストリインスタンス
registry = ToolRegistry()
