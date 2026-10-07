import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, LogEntry, ServerInfo, StatsSnapshot, ToolEntry, ApiKeyInfo } from './api';
import './styles.css';

type View = 'servers' | 'tools' | 'logs' | 'usage' | 'keys';

function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let cancelled = false;
    fn()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    const timer = setInterval(() => {
      fn()
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        });
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, tick, ...deps]);
  return { data, error, refresh };
}

function TokenGate({ onAuth }: { onAuth: () => void }) {
  const [value, setValue] = useState(getToken());
  return (
    <div className="gate">
      <h2>Admin token required</h2>
      <p>Paste the gateway admin token (MCP_GW_ADMIN_TOKEN) to manage this gateway.</p>
      <div className="row">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="admin token"
        />
        <button
          onClick={() => {
            setToken(value);
            onAuth();
          }}
        >
          Connect
        </button>
      </div>
    </div>
  );
}

function ServersView() {
  const { data, error, refresh } = usePoll<ServerInfo[]>(api.servers, 5000);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('node');
  const [args, setArgs] = useState('demo-servers/calc.ts');
  const [formError, setFormError] = useState<string | null>(null);

  const register = async () => {
    setFormError(null);
    try {
      await api.registerServer(name.trim(), {
        type: 'stdio',
        command: command.trim(),
        args: args.split(/\s+/).filter(Boolean),
      });
      setName('');
      refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      <h2>Upstream servers</h2>
      {error && <p className="error">{error}</p>}
      <div className="cards">
        {(data ?? []).map((s) => (
          <div key={s.id} className="card">
            <div className="card-head">
              <strong>{s.name}</strong>
              <span className={`status ${s.status}`}>{s.status}</span>
            </div>
            <div className="muted">
              {s.serverInfo ? `${s.serverInfo.name} v${s.serverInfo.version}` : 'not connected'}
              {' · '}
              {s.tools.length} tools
            </div>
            {s.lastError && <div className="error small">{s.lastError}</div>}
            <button
              className="danger"
              onClick={() => api.removeServer(s.id).then(refresh).catch(() => undefined)}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <h3>Register a server</h3>
      <div className="form">
        <label>
          Name (tool prefix)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="calc" />
        </label>
        <label>
          Command
          <input value={command} onChange={(e) => setCommand(e.target.value)} />
        </label>
        <label>
          Args (space separated)
          <input value={args} onChange={(e) => setArgs(e.target.value)} />
        </label>
        <button onClick={register}>Register</button>
        {formError && <p className="error">{formError}</p>}
      </div>
    </section>
  );
}

function ToolsView() {
  const { data, error } = usePoll<ToolEntry[]>(api.tools, 10000);
  const groups = new Map<string, ToolEntry[]>();
  for (const t of data ?? []) {
    const list = groups.get(t.server) ?? [];
    list.push(t);
    groups.set(t.server, list);
  }
  return (
    <section>
      <h2>Tool catalog</h2>
      {error && <p className="error">{error}</p>}
      {[...groups.entries()].map(([server, tools]) => (
        <div key={server} className="group">
          <h3>{server}</h3>
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name}>
                  <td>
                    <code>
                      {server}__{t.name}
                    </code>
                  </td>
                  <td className="muted">{t.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function LogsView() {
  const { data, error } = usePoll<LogEntry[]>(() => api.logs(100), 2000);
  return (
    <section>
      <h2>Live request log</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Key</th>
            <th>Tool</th>
            <th>Latency</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((l, i) => (
            <tr key={`${l.ts}-${i}`}>
              <td className="muted">{new Date(l.ts).toLocaleTimeString()}</td>
              <td>{l.keyName}</td>
              <td>
                <code>{l.tool}</code>
              </td>
              <td>{l.latencyMs}ms</td>
              <td className={l.ok ? 'ok' : 'fail'}>{l.ok ? 'ok' : l.error ?? 'error'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BarChart({ title, entries }: { title: string; entries: Array<[string, number]> }) {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="chart">
      <h3>{title}</h3>
      {entries.length === 0 && <p className="muted">No data yet. Send some tool calls through the gateway.</p>}
      {entries.map(([label, value]) => (
        <div key={label} className="bar-row">
          <span className="bar-label">
            <code>{label}</code>
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(value / max) * 100}%` }} />
          </div>
          <span className="bar-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

function UsageView() {
  const { data, error } = usePoll<StatsSnapshot>(api.stats, 5000);
  const toolEntries = Object.entries(data?.perTool ?? {})
    .map(([k, v]): [string, number] => [k, v.calls])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  const tenantEntries = Object.entries(data?.perTenant ?? {})
    .map(([k, v]): [string, number] => [k.slice(0, 12), v.calls])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  return (
    <section>
      <h2>Usage</h2>
      {error && <p className="error">{error}</p>}
      <div className="stat-row">
        <div className="stat">
          <div className="stat-num">{data?.totalCalls ?? 0}</div>
          <div className="muted">total calls</div>
        </div>
        <div className="stat">
          <div className="stat-num">{data?.totalErrors ?? 0}</div>
          <div className="muted">total errors</div>
        </div>
      </div>
      <BarChart title="Calls per tool" entries={toolEntries} />
      <BarChart title="Calls per tenant" entries={tenantEntries} />
    </section>
  );
}

function KeysView() {
  const { data, error, refresh } = usePoll<ApiKeyInfo[]>(api.keys, 10000);
  const [name, setName] = useState('');
  const [servers, setServers] = useState('*');
  const [secret, setSecret] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const create = async () => {
    setFormError(null);
    setSecret(null);
    try {
      const res = await api.createKey({
        name: name.trim(),
        servers: servers.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setSecret(res.secret);
      setName('');
      refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      <h2>API keys</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>Scopes</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>
                <code>{k.keyPrefix}…</code>
              </td>
              <td className="muted">{k.servers.join(', ')}</td>
              <td className="muted">{new Date(k.createdAt).toLocaleString()}</td>
              <td>
                <button className="danger" onClick={() => api.revokeKey(k.id).then(refresh)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Create a key</h3>
      <div className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="agent-1" />
        </label>
        <label>
          Server scopes (comma separated, * for all)
          <input value={servers} onChange={(e) => setServers(e.target.value)} />
        </label>
        <button onClick={create}>Create</button>
        {formError && <p className="error">{formError}</p>}
        {secret && (
          <p className="secret">
            Copy this secret now, it is shown once: <code>{secret}</code>
          </p>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [view, setView] = useState<View>('servers');
  const [authed, setAuthed] = useState(() => getToken() !== '');

  const views: Array<[View, string]> = [
    ['servers', 'Servers'],
    ['tools', 'Tools'],
    ['logs', 'Live log'],
    ['usage', 'Usage'],
    ['keys', 'API keys'],
  ];

  return (
    <div className="app">
      <header>
        <h1>MCP Gateway</h1>
        <nav>
          {views.map(([v, label]) => (
            <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {!authed ? (
          <TokenGate onAuth={() => setAuthed(true)} />
        ) : (
          <>
            {view === 'servers' && <ServersView />}
            {view === 'tools' && <ToolsView />}
            {view === 'logs' && <LogsView />}
            {view === 'usage' && <UsageView />}
            {view === 'keys' && <KeysView />}
          </>
        )}
      </main>
    </div>
  );
}
