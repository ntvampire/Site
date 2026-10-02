# Инструкция: Автоматическая пересборка сайта при пуше в другие репозитории

Чтобы ваш сайт-каталог (`Site`) автоматически обновлялся сразу после того, как вы сделали `git push` в **любой другой свой проект**, используется стандартный механизм GitHub: **`repository_dispatch`**.

---

### Шаг 1. Создайте Personal Access Token (PAT)
Чтобы один ваш репозиторий мог отправить сигнал в репозиторий `Site`, нужен токен с правами отправки событий:

1. Перейдите в [GitHub Settings -> Developer Settings -> Personal access tokens -> Fine-grained tokens](https://github.com/settings/tokens?type=beta) (или классический токен `Tokens (classic)`).
2. Нажмите **Generate new token**.
3. Назовите его, например, `PORTFOLIO_DISPATCH_TOKEN`.
4. В разделе **Repository access** выберите *Only select repositories* -> выберите репозиторий **Site**.
5. В разделе **Permissions** -> **Repository permissions** найдите **Contents** и поставьте `Read and write` (или для классического токена отметьте область `repo`).
6. Скопируйте созданный токен.

---

### Шаг 2. Добавьте секрет в ваш другой репозиторий (или глобально в аккаунт)
1. В репозитории вашего проекта перейдите в **Settings** -> **Secrets and variables** -> **Actions**.
   *(Либо в настройках профиля GitHub -> Settings -> Secrets and variables -> Actions, чтобы токен действовал для всех ваших проектов сразу!)*
2. Нажмите **New repository secret** (или **New organization/user secret**).
3. Имя: `SITE_TRIGGER_TOKEN`.
4. Значение: вставьте созданный ранее токен.

---

### Шаг 3. Добавьте workflow в ваш другой проект
В том репозитории, за обновлениями которого вы хотите следить, создайте файл `.github/workflows/notify-portfolio.yml`:

```yaml
name: Notify Portfolio Site

on:
  push:
    branches:
      - main
      - master

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Portfolio Rebuild
        run: |
          curl -L \
            -X POST \
            -H "Accept: application/vnd.github+json" \
            -H "Authorization: Bearer ${{ secrets.SITE_TRIGGER_TOKEN }}" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            https://api.github.com/repos/${{ github.repository_owner }}/Site/dispatches \
            -d '{"event_type":"projects_updated"}'
```

### Как это работает:
1. Вы пушите коммит в любой свой проект.
2. Этот легковесный workflow отправляет POST-запрос в GitHub API репозитория `Site`.
3. В репозитории `Site` срабатывает событие `repository_dispatch`, скачиваются свежие данные репозиториев и обновляется страница на GitHub Pages!
