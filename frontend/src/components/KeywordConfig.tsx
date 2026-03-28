import { useEffect, useState } from 'react';
import { Search, MapPin, Plus, X, Save, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { t, type Locale } from '../lib/i18n';

interface KeywordConfigProps {
  onConfigChange?: () => void;
  locale: Locale;
}

export function KeywordConfig({ onConfigChange, locale }: KeywordConfigProps) {
  const [keywords, setKeywords] = useState<string[]>([]);
  const [location, setLocation] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch('/api/config/keywords')
      .then(r => r.json())
      .then((data: { keywords: string[]; location: string }) => {
        setKeywords(data.keywords);
        setLocation(data.location);
      })
      .catch(() => {});
  }, []);

  const addKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw || keywords.includes(kw)) return;
    setKeywords([...keywords, kw]);
    setNewKeyword('');
    setDirty(true);
  };

  const removeKeyword = (kw: string) => {
    setKeywords(keywords.filter(k => k !== kw));
    setDirty(true);
  };

  const handleSave = async () => {
    if (keywords.length === 0) {
      setMessage({ text: t('keyword.minOne', locale), type: 'error' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const resp = await fetch('/api/config/keywords', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords, location }),
      });
      if (!resp.ok) throw new Error('Save failed');
      const data = await resp.json();
      setKeywords(data.keywords);
      setLocation(data.location);
      setDirty(false);
      setMessage({ text: `✓ ${t('keyword.saved', locale)}`, type: 'success' });
      onConfigChange?.();
      setTimeout(() => setMessage(null), 3000);
    } catch {
      setMessage({ text: t('keyword.saveFailed', locale), type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    try {
      const resp = await fetch('/api/config/keywords');
      const data = await resp.json();
      setKeywords(data.keywords);
      setLocation(data.location);
      setDirty(false);
      setMessage(null);
    } catch {
      // ignore
    }
  };

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs uppercase tracking-widest font-semibold text-[var(--color-text-secondary)] font-mono">
          {t('keyword.title', locale)}
        </h2>
        <Search className="w-4 h-4 text-[var(--color-accent)]" />
      </div>

      <div className="space-y-2 mb-4">
        <label className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-text-dim)] font-mono flex items-center gap-1">
          <Search className="w-3 h-3" /> {t('keyword.keywords', locale)}
        </label>
        <div className="flex flex-wrap gap-1.5">
          <AnimatePresence>
            {keywords.map(kw => (
              <motion.span
                key={kw}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--color-accent-light)] text-[var(--color-accent)] border border-[var(--color-accent)]/20"
              >
                {kw}
                <button
                  onClick={() => removeKeyword(kw)}
                  className="ml-0.5 hover:text-[var(--color-danger)] transition-colors"
                  aria-label={`${t('keyword.remove', locale)}: ${kw}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>

        <div className="flex gap-1.5">
          <input
            type="text"
            value={newKeyword}
            onChange={e => setNewKeyword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addKeyword()}
            placeholder={t('keyword.addPlaceholder', locale)}
            className="flex-1 px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] text-sm font-mono focus:outline-none focus:border-[var(--color-accent)] transition-colors"
          />
          <button
            onClick={addKeyword}
            disabled={!newKeyword.trim()}
            className="px-2.5 py-1.5 rounded-lg bg-[var(--color-accent)] text-white disabled:opacity-40 transition-all hover:opacity-90"
            aria-label={t('keyword.add', locale)}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        <label className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-text-dim)] font-mono flex items-center gap-1">
          <MapPin className="w-3 h-3" /> {t('keyword.location', locale)}
        </label>
        <input
          type="text"
          value={location}
          onChange={e => { setLocation(e.target.value); setDirty(true); }}
          className="w-full px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] text-sm font-mono focus:outline-none focus:border-[var(--color-accent)] transition-colors"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="flex-1 flex justify-center items-center gap-1.5 py-2 rounded-lg bg-[var(--color-accent)] text-white text-xs font-semibold disabled:opacity-40 transition-all hover:opacity-90"
        >
          {saving ? (
            <div className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          {t('keyword.save', locale)}
        </button>
        {dirty && (
          <button
            onClick={handleReset}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-dim)] hover:text-[var(--color-text)] transition-colors"
            aria-label={t('keyword.reset', locale)}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {message && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={`text-xs font-mono mt-2 text-center ${message.type === 'success' ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}
        >
          {message.text}
        </motion.p>
      )}

      <p className="text-[10px] text-[var(--color-text-dim)] font-mono mt-3 opacity-60">
        {t('keyword.savedToDb', locale)}
      </p>
    </div>
  );
}
