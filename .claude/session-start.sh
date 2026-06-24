#!/usr/bin/env bash
# SessionStart hook — короткая ориентация по проекту в начале сессии.
set -e
echo "📁 Проект «Глубже» (Site-masterdiver). Полная карта проекта — в CLAUDE.md."
echo "🌿 Ветка: $(git branch --show-current 2>/dev/null || echo '?') (разработка тут, PR в main; в main не пушить напрямую)"
changes=$(git status --short 2>/dev/null | head -5)
if [ -n "$changes" ]; then echo "✏️  Незакоммиченные изменения:"; echo "$changes"; fi
echo "🔧 Перед пушем правок воркера: npm run check"
