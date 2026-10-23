# FlowFinance Bot

Bot do Telegram que transforma mensagens como "almoço 32,50 débito itaú" em lançamentos do FlowFinance.

- Projeto Apps Script separado e público, que só recebe mensagens do Telegram.
- Usa o FlowFinance como biblioteca (`FF`) para ler contas, cartões e categorias e para gravar.
- A IA só interpreta; nada é gravado sem o seu toque em **Confirmar**.
- Segredos (token, chave da IA) ficam nas Propriedades do Script, nunca no código.

## Fase 1: o que funciona

- Texto livre: valor, local, data, conta ou cartão, categoria, parcelas.
- Botões: Confirmar, Categoria, Pagamento, Data, É receita/despesa, Cancelar, Desfazer.
- Suas regras da aba Regras têm prioridade sobre a categoria sugerida pela IA.
- Cada lançamento grava `origem = telegram` e `quem` (quem mandou).
- Comandos: `/start`, `/ajuda`, `/desfazer`, `/id`.

## Consultas e áudio

- Perguntas em texto ou áudio: "quanto gastei em mercado este mês?", "qual o saldo do BB?", "o que vence esta semana?", "como está a fatura do XP?".
- Comandos: `/resumo`, `/saldos`, `/contas` (a pagar em 7 dias), `/faturas`, `/orcamentos`.
- Áudio: o bot transcreve a voz com o Whisper da Groq (gratuito) e segue como se fosse texto, mostrando o que ouviu.

Para ativar o áudio: crie uma conta em console.groq.com, gere uma API key e crie a propriedade `GROQ_API_KEY` no projeto do bot. Rode `testarChaveAudio` para conferir.

## Instalação (uma vez)

No Codespace, na raiz do repositório:

```bash
git pull
clasp push            # envia ao FlowFinance a coluna "quem"
cd bot
clasp -P . create --type standalone --title "FlowFinance Bot"
git checkout appsscript.json   # o create baixa um manifesto padrão; volta o do repositório
rm -f Code.js Code.gs          # arquivo de exemplo que o create baixa
clasp push            # se perguntar sobre o manifesto, responda "y"
```

Depois, no editor do Apps Script do **FlowFinance Bot** (script.google.com):

1. **Configurações do projeto › Propriedades do script**: crie `TELEGRAM_TOKEN` e `ANTHROPIC_API_KEY`.
2. Em **Executar**, rode `gerarSegredoWebhook` e autorize o acesso.
3. **Implantar › Nova implantação › App da Web**: executar como **Eu**, acesso **Qualquer pessoa**. Copie a URL.
4. Crie a propriedade `WEBAPP_URL` com essa URL.
5. Rode `configurarWebhook`.
6. No Telegram, mande `/start` ao bot. Ele responde com o seu ID.
7. Crie a propriedade `USUARIOS`, por exemplo `{"123456789": "Willyam"}`. Para incluir sua esposa: `{"123456789": "Willyam", "987654321": "Nome"}`.
8. Rode `verificarConfig` e `testarIA` para conferir.

Depois de mudar o código: `clasp push` dentro de `bot/` e, no editor, **Implantar › Gerenciar implantações › editar › Nova versão**.
