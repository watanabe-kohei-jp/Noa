"""
Tool Registry — ツール定義の一元管理

全ての Brain ツール (builtin + integration) を ToolDefinition として登録し、
プロンプト生成・実行・follow-up 判定を registry 経由で行う。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


@dataclass
class ToolDefinition:
    """単一ツールの登録エントリ"""
    name: str
    description: str                                    # TOOL_SELECTION_PROMPT 向けの説明
    args_description: str                               # args フォーマット文字列
    handler: Callable[..., Awaitable[dict[str, Any]]]   # async (args, meeting_context) -> result
    read_only: bool = True
    follow_up_allowed: bool = False
    requires_confirmation: bool = False
    category: str = "builtin"                           # "builtin" | "integration"


class ToolRegistry:
    """ツール登録・検索・実行を管理する中央レジストリ"""

    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    # -- 登録 / 取得 --

    def register(self, tool: ToolDefinition) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    @property
    def tool_names(self) -> list[str]:
        return list(self._tools.keys())

    # -- 実行 --

    async def execute(self, name: str, args: dict, context: dict) -> dict:
        tool = self._tools.get(name)
        if tool is None:
            raise ValueError(f"Unknown tool: {name}")
        return await tool.handler(args, context)

    # -- プロンプト生成 --

    def build_tool_prompt(self) -> str:
        """TOOL_SELECTION_PROMPT に埋め込むツール一覧テキストを生成。

        注意: 出力は str.format() でテンプレートに挿入されるため、
        JSON リテラルの中括弧は {{ }} でエスケープ済みの args_description をそのまま使う。
        """
        lines: list[str] = []
        for tool in self._tools.values():
            lines.append(f"- {tool.name}: {tool.description}")
            lines.append(f"  args: {tool.args_description}")
            lines.append("")
        return "\n".join(lines)

    def build_follow_up_tool_list(self) -> str:
        """FOLLOW_UP_PROMPT に埋め込む follow-up 許可ツール名のカンマ区切りリスト"""
        return ", ".join(
            name for name, t in self._tools.items() if t.follow_up_allowed
        )

    def get_follow_up_allowed(self) -> set[str]:
        """follow-up チェーンで許可されるツール名の set を返す"""
        return {name for name, t in self._tools.items() if t.follow_up_allowed}

    # -- テスト用 --

    def reset(self) -> None:
        """全登録をクリアする (テスト間の状態汚染防止用)"""
        self._tools.clear()


# モジュールレベルのシングルトン
registry = ToolRegistry()
