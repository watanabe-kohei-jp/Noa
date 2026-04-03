"""外部サービス統合の基底クラス"""
from abc import ABC, abstractmethod

from integrations.registry import ToolDefinition


class IntegrationBase(ABC):
    """外部サービス統合の基底クラス。Phase 1 以降で継承して使用。"""

    @abstractmethod
    def get_tool_definitions(self) -> list[ToolDefinition]:
        """この統合が提供するツール定義のリストを返す"""
        ...

    @abstractmethod
    async def is_available(self, uid: str) -> bool:
        """指定ユーザーがこの統合を利用可能かどうかを返す"""
        ...
