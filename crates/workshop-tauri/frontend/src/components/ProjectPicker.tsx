import { useState } from "react";

interface Props {
  recents: string[];
  onOpen: (path?: string) => void;
}

export default function ProjectPicker({ recents, onOpen }: Props) {
  const [path, setPath] = useState("");

  return (
    <div className="h-screen flex items-center justify-center bg-surface-0 text-gray-200">
      <div className="w-full max-w-lg p-8 bg-surface-1 rounded-lg border border-surface-3 shadow-xl">
        <h1 className="text-2xl font-semibold text-accent mb-2">Metalcraft Workshop</h1>
        <p className="text-sm text-gray-400 mb-6">
          Open a <code className="text-accent-light">metalcraft-agent</code> project directory to
          view and edit its personas, skills, flows, and diagnostics logs.
        </p>

        <button
          onClick={() => onOpen()}
          className="w-full px-4 py-2 mb-4 bg-accent hover:bg-accent-light text-white rounded font-medium"
        >
          Browse for directory…
        </button>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) onOpen(path.trim());
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="or paste an absolute path"
            spellCheck={false}
            className="flex-1 px-3 py-2 bg-surface-2 border border-surface-3 rounded font-mono text-sm"
          />
          <button
            type="submit"
            disabled={!path.trim()}
            className="px-3 py-2 bg-surface-2 hover:bg-surface-3 text-gray-200 rounded text-sm disabled:opacity-40"
          >
            Open
          </button>
        </form>

        {recents.length > 0 && (
          <div className="mt-8">
            <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Recent</h2>
            <ul className="space-y-1">
              {recents.map((r) => (
                <li key={r}>
                  <button
                    onClick={() => onOpen(r)}
                    className="w-full text-left px-2 py-1 text-sm text-gray-300 hover:bg-surface-2 hover:text-accent-light rounded font-mono truncate"
                    title={r}
                  >
                    {r}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
