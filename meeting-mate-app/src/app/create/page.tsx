'use client';

import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// プロバイダー別の利用可能モデル
const PROVIDER_MODELS: Record<string, { label: string; models: string[] }> = {
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  anthropic: {
    label: 'Anthropic Claude',
    models: ['claude-sonnet-4-5-20250929', 'claude-opus-4-20250514'],
  },
};

// エージェント一覧
const AGENTS = [
  { key: 'orchestrator', label: 'オーケストレーター' },
  { key: 'TaskManagementAgent', label: 'タスク管理' },
  { key: 'NotesGeneratorAgent', label: 'ノート生成' },
  { key: 'AgendaManagementAgent', label: 'アジェンダ管理' },
  { key: 'ParticipantManagementAgent', label: '参加者管理' },
  { key: 'OverviewDiagramAgent', label: '概要図生成' },
];

export default function CreateRoomPage() {
  const { currentUser, loading } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string>('');
  const [roomName, setRoomName] = useState<string>('');
  const [meetingSubtitle, setMeetingSubtitle] = useState<string>('');
  const [participantName, setParticipantName] = useState<string>('');
  const [representativeMode, setRepresentativeMode] = useState<boolean>(false);
  const [apiKeyDurationHours, setApiKeyDurationHours] = useState<number>(24);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [hasCreated, setHasCreated] = useState<boolean>(false);

  // マルチプロバイダー APIキー
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({
    gemini: '',
    openai: '',
    anthropic: '',
  });

  // デフォルトモデル
  const [defaultModel, setDefaultModel] = useState<string>('gemini-2.5-flash');

  // エージェント別モデル設定 (空文字 = デフォルト使用)
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});

  // STT/TTS プロバイダー
  const [sttProvider, setSttProvider] = useState<string>('browser');
  const [ttsProvider, setTtsProvider] = useState<string>('none');

  // 詳細設定の表示/非表示
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);

  // 全プロバイダーのモデル一覧 (フラットリスト)
  const allModels = Object.entries(PROVIDER_MODELS).flatMap(([, config]) =>
    config.models.map(m => ({ model: m, provider: config.label }))
  );

  // 少なくとも1つのAPIキーが入力されているか
  const hasAnyApiKey = Object.values(apiKeys).some(k => k.trim() !== '');

  // デフォルトモデルのプロバイダーのAPIキーがあるか
  const defaultModelProvider = Object.entries(PROVIDER_MODELS).find(([, config]) =>
    config.models.includes(defaultModel)
  )?.[0] || '';
  const hasDefaultProviderKey = defaultModelProvider ? apiKeys[defaultModelProvider]?.trim() !== '' : false;

  // 後方互換: 旧形式の llm_api_key と llm_models も送信
  const primaryApiKey = apiKeys[defaultModelProvider] || Object.values(apiKeys).find(k => k.trim()) || '';

  const handleCreateRoom = async () => {
    if (!currentUser) {
      setError("ログインしていません。まずログインしてください。");
      return;
    }

    if (isCreating || hasCreated) return;

    setError(null);
    setIsCreating(true);

    if (!roomId.trim()) {
      setError("ルームIDを入力してください。");
      setIsCreating(false);
      return;
    }

    if (!roomName.trim()) {
      setError("ルーム名を入力してください。");
      setIsCreating(false);
      return;
    }

    if (!hasAnyApiKey) {
      setError("少なくとも1つのプロバイダーのAPIキーを入力してください。");
      setIsCreating(false);
      return;
    }

    if (!hasDefaultProviderKey) {
      setError(`デフォルトモデル (${defaultModel}) のプロバイダーのAPIキーが入力されていません。`);
      setIsCreating(false);
      return;
    }

    if (apiKeyDurationHours < 1 || apiKeyDurationHours > 8760) {
      setError("APIキー持続時間は1時間から8760時間（1年）の間で設定してください。");
      setIsCreating(false);
      return;
    }

    try {
      const idToken = await currentUser.getIdToken();

      // 空でないAPIキーのみ送信
      const filteredApiKeys: Record<string, string> = {};
      for (const [provider, key] of Object.entries(apiKeys)) {
        if (key.trim()) filteredApiKeys[provider] = key.trim();
      }

      // 空でないエージェントモデル設定のみ送信
      const filteredAgentModels: Record<string, string> = {};
      for (const [agent, model] of Object.entries(agentModels)) {
        if (model.trim()) filteredAgentModels[agent] = model.trim();
      }

      const response = await fetch(`/create_room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          room_id: roomId.trim(),
          room_name: roomName.trim(),
          meeting_subtitle: meetingSubtitle.trim(),
          // 後方互換フィールド
          llm_api_key: primaryApiKey,
          llm_models: [defaultModel],
          // 新フィールド
          api_keys: filteredApiKeys,
          default_model: defaultModel,
          agent_models: filteredAgentModels,
          stt_provider: sttProvider === 'browser' ? null : sttProvider,
          tts_provider: ttsProvider === 'none' ? null : ttsProvider,
          speakerName: participantName.trim() || currentUser.displayName || currentUser.email || currentUser.uid,
          representativeMode: representativeMode,
          api_key_duration_hours: apiKeyDurationHours,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to create new room');
      }

      console.log(`Successfully created room ${roomId} via API`);
      setHasCreated(true);
      router.push(`/room/${roomId}`);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unknown error occurred while creating the room.");
      }
      console.error("Create room error:", err);
    } finally {
      if (!hasCreated) {
        setIsCreating(false);
      }
    }
  };

  if (loading) {
    return <div className="flex min-h-screen flex-col items-center justify-center p-24">Loading...</div>;
  }

  if (!currentUser) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-slate-100">
        <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-xl">
          <h1 className="text-3xl font-bold text-center text-slate-800 mb-8">ルームを作成</h1>
          <div className="text-center">
            <p className="text-slate-600 mb-6">ルームを作成するには、まずログインが必要です。</p>
            <Link
              href="/"
              className="inline-flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              ログインページへ
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-100 py-8">
      <div className="max-w-2xl w-full p-8 bg-white rounded-lg shadow-xl">
        <h1 className="text-3xl font-bold text-center text-slate-800 mb-8">新しいルームを作成</h1>

        {error && <p className="text-red-500 text-center mb-4 bg-red-100 p-3 rounded-md">{error}</p>}

        <div className="text-center mb-6">
          <p className="text-lg text-slate-700">ようこそ、{currentUser.displayName || 'ユーザー'}!</p>
          <p className="text-sm text-slate-500">新しいルームの詳細を入力してください。</p>
        </div>

        <div className="space-y-4">
          {/* ルームID */}
          <div>
            <label htmlFor="createRoomIdInput" className="block text-sm font-medium text-slate-700 mb-1">
              ルームID <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              id="createRoomIdInput"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              placeholder="新しいルームIDを入力"
              required
            />
          </div>

          {/* ルーム名 */}
          <div>
            <label htmlFor="roomNameInput" className="block text-sm font-medium text-slate-700 mb-1">
              ルーム名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              id="roomNameInput"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              placeholder="ルーム名を入力 (例: プロジェクトキックオフ)"
              required
            />
          </div>

          {/* 会議サブタイトル */}
          <div>
            <label htmlFor="meetingSubtitleInput" className="block text-sm font-medium text-slate-700 mb-1">
              会議サブタイトル
            </label>
            <input
              type="text"
              id="meetingSubtitleInput"
              value={meetingSubtitle}
              onChange={(e) => setMeetingSubtitle(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              placeholder="会議サブタイトルを入力 (例: 第1回定例)"
            />
          </div>

          {/* 参加者名 */}
          <div>
            <label htmlFor="participantNameInput" className="block text-sm font-medium text-slate-700 mb-1">
              参加者名 (オプション)
            </label>
            <input
              type="text"
              id="participantNameInput"
              value={participantName}
              onChange={(e) => setParticipantName(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              placeholder="あなたの名前を入力 (例: 山田太郎)"
            />
            <p className="text-xs text-slate-500 mt-1">
              入力しない場合は、アカウント情報が使用されます
            </p>
          </div>

          {/* 代表参加者モード */}
          <div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="representativeModeCheckbox"
                checked={representativeMode}
                onChange={(e) => setRepresentativeMode(e.target.checked)}
                className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-slate-300 rounded"
              />
              <label htmlFor="representativeModeCheckbox" className="ml-2 block text-sm font-medium text-slate-700">
                代表参加者モード
              </label>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              有効にすると、発言者を特定せずに議事録を作成します。書記のみが確認する場合や、全員がサインインしない場合に使用してください。
            </p>
          </div>

          {/* === AI プロバイダー設定セクション === */}
          <div className="border-t border-slate-200 pt-4 mt-6">
            <h2 className="text-lg font-semibold text-slate-800 mb-3">AI プロバイダー設定</h2>

            {/* プロバイダー別APIキー */}
            {Object.entries(PROVIDER_MODELS).map(([providerKey, config]) => (
              <div key={providerKey} className="mb-3">
                <label htmlFor={`apiKey-${providerKey}`} className="block text-sm font-medium text-slate-700 mb-1">
                  {config.label} APIキー {providerKey === defaultModelProvider && <span className="text-red-500">*</span>}
                </label>
                <input
                  type="password"
                  id={`apiKey-${providerKey}`}
                  value={apiKeys[providerKey] || ''}
                  onChange={(e) => setApiKeys(prev => ({ ...prev, [providerKey]: e.target.value }))}
                  className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  placeholder={`${config.label} APIキーを入力`}
                />
              </div>
            ))}
          </div>

          {/* デフォルトモデル選択 */}
          <div>
            <label htmlFor="defaultModelSelect" className="block text-sm font-medium text-slate-700 mb-1">
              デフォルトLLMモデル <span className="text-red-500">*</span>
            </label>
            <select
              id="defaultModelSelect"
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
            >
              {allModels.map(({ model, provider }) => (
                <option key={model} value={model}>
                  {model} ({provider})
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">
              全エージェントで使用されるデフォルトのモデルです。エージェント別に個別設定も可能です。
            </p>
          </div>

          {/* APIキー持続時間 */}
          <div>
            <label htmlFor="apiKeyDurationInput" className="block text-sm font-medium text-slate-700 mb-1">
              APIキー持続時間 (時間)
            </label>
            <input
              type="number"
              id="apiKeyDurationInput"
              value={apiKeyDurationHours}
              onChange={(e) => {
                const value = e.target.value;
                if (value === '') {
                  setApiKeyDurationHours(24);
                } else {
                  const numValue = parseInt(value);
                  if (!isNaN(numValue) && numValue >= 1 && numValue <= 8760) {
                    setApiKeyDurationHours(numValue);
                  }
                }
              }}
              min="1"
              max="8760"
              className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
              placeholder="24"
            />
            <p className="text-xs text-slate-500 mt-1">
              1時間から8760時間（1年）まで設定可能です。デフォルトは24時間です。
            </p>
          </div>

          {/* 詳細設定トグル */}
          <div className="border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm text-indigo-600 hover:text-indigo-500 font-medium"
            >
              {showAdvanced ? '▼ 詳細設定を閉じる' : '▶ 詳細設定 (エージェント別モデル・STT/TTS)'}
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-4 bg-slate-50 p-4 rounded-lg">
              {/* エージェント別モデル設定 */}
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-2">エージェント別モデル設定</h3>
                <p className="text-xs text-slate-500 mb-3">
                  空欄の場合はデフォルトモデル ({defaultModel}) が使用されます。
                </p>
                {AGENTS.map(({ key, label }) => (
                  <div key={key} className="mb-2">
                    <label htmlFor={`agent-${key}`} className="block text-xs font-medium text-slate-600 mb-1">
                      {label}
                    </label>
                    <select
                      id={`agent-${key}`}
                      value={agentModels[key] || ''}
                      onChange={(e) => setAgentModels(prev => ({ ...prev, [key]: e.target.value }))}
                      className="block w-full px-2 py-1.5 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 text-xs"
                    >
                      <option value="">デフォルト ({defaultModel})</option>
                      {allModels.map(({ model, provider }) => (
                        <option key={model} value={model}>
                          {model} ({provider})
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {/* STT プロバイダー */}
              <div>
                <label htmlFor="sttProviderSelect" className="block text-sm font-medium text-slate-700 mb-1">
                  音声認識 (STT) プロバイダー
                </label>
                <select
                  id="sttProviderSelect"
                  value={sttProvider}
                  onChange={(e) => setSttProvider(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                >
                  <option value="browser">ブラウザ内蔵 (Web Speech API)</option>
                  <option value="openai">OpenAI Whisper (バックエンド)</option>
                  <option value="google">Google Cloud Speech-to-Text (バックエンド)</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  バックエンドSTTを使用する場合は対応するAPIキーが必要です。
                </p>
              </div>

              {/* TTS プロバイダー */}
              <div>
                <label htmlFor="ttsProviderSelect" className="block text-sm font-medium text-slate-700 mb-1">
                  音声合成 (TTS) プロバイダー
                </label>
                <select
                  id="ttsProviderSelect"
                  value={ttsProvider}
                  onChange={(e) => setTtsProvider(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                >
                  <option value="none">無効</option>
                  <option value="openai">OpenAI TTS (バックエンド)</option>
                  <option value="google">Google Cloud Text-to-Speech (バックエンド)</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  有効にするとAIの応答を音声で読み上げます。対応するAPIキーが必要です。
                </p>
              </div>
            </div>
          )}

          <button
            onClick={handleCreateRoom}
            disabled={!roomId.trim() || !roomName.trim() || !hasAnyApiKey || !hasDefaultProviderKey || isCreating || hasCreated}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {isCreating ? (
              <div className="flex items-center">
                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                作成中...
              </div>
            ) : (
              'このルームを作成する'
            )}
          </button>
        </div>

        <div className="mt-8 text-center">
          <Link
            href="/"
            className="text-indigo-600 hover:text-indigo-500 text-sm"
          >
            ← ホームに戻る
          </Link>
        </div>
      </div>
    </main>
  );
}
