Репозиторий: https://github.com/Tsynskyy/pp2-status-page/tree/hw1

# Status Page

ДЗ 1: требования и сервер

Приложение: страница статусов и инцидентов сервисов

Функциональные и нефункциональные требования: [REQUIREMENTS.md](REQUIREMENTS.md)

## Запуск

```bash
API_TOKEN=$(openssl rand -hex 16) docker compose up --build
```

API - http://localhost:8000

описание OpenAPI - http://localhost:8000/docs

## API

| Запрос | Кто | Что делает |
|---|---|---|
| `GET /status` | все | общий статус, сервисы, открытые инциденты |
| `GET /services` | все | список сервисов |
| `POST /services` | только оператор | добавить сервис |
| `PUT /services/{id}` | только оператор | изменить сервис |
| `DELETE /services/{id}` | только оператор | удалить сервис |
| `GET /services/{id}/checks` | все | последние 100 проверок |
| `GET /incidents` | все | последние 100 инцидентов |
| `POST /incidents` | только оператор | открыть инцидент |
| `POST /incidents/{id}/close` | только оператор | закрыть инцидент |
| `GET /health` | все | healthcheck |