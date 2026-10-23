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

## Aprende com as correções

Quando você troca a categoria sugerida antes de confirmar, o bot cria uma regra na aba Regras (até 3 palavras da descrição → categoria, prioridade 10). Na próxima vez, ele já acerta.

## Consultas e áudio

- Perguntas em texto ou áudio: "quanto gastei em mercado este mês?", "qual o saldo do BB?", "o que vence esta semana?", "como está a fatura do XP?".
- Comandos: `/resumo`, `/saldos`, `/contas` (a pagar em 7 dias), `/faturas`, `/orcamentos`.
- Áudio: o bot transcreve a voz com o Whisper da Groq (gratuito) e segue como se fosse texto, mostrando o que ouviu.

Para ativar o áudio: crie uma conta em console.groq.com, gere uma API key e crie a propriedade `GROQ_API_KEY` no projeto do bot. Rode `testarChaveAudio` para conferir.

## Foto do cupom ou comprovante

Mande a foto (ou um PDF) do cupom fiscal, da NFC-e ou do comprovante de Pix/maquininha. A IA lê loja, valor pago, data, forma de pagamento e itens, e monta o rascunho com os botões de sempre.

- Legenda opcional diz o pagamento: `xp`, `itaú`, `iti`, `vale`. Sem legenda, o bot pergunta.
- Itens, desconto, CNPJ e a chave de acesso da NFC-e vão para a observação do lançamento (`origem = cupom`).
- Se já existe um lançamento do mesmo valor em até 2 dias (por exemplo, o da notificação do banco), o bot pergunta se é o mesmo gasto. **Juntar** completa aquele lançamento com o nome da loja, a categoria e os itens, sem criar outro; Desfazer volta como era.
- Se a foto chega primeiro, a notificação do mesmo valor depois só avisa que já está lançado.
- A foto em si ainda não é guardada (precisaria de acesso ao Google Drive).

### Cupom comprido em várias fotos

O Telegram reduz cada foto a ~1280 px; num cupom de mercado inteiro numa foto só, as letras ficam ilegíveis. Mande o cupom em 2 a 6 fotos de uma vez (álbum), de cima para baixo: o bot relê todas juntas a cada foto que chega, no mesmo rascunho, sem repetir o item da emenda. Para acrescentar uma parte depois, responda ao rascunho com a foto. A categoria que você já escolheu no rascunho é mantida.

### Itens oficiais pela SEFAZ

Desde set/2025 o QR code da NFC-e (versão 3) é só a chave de acesso. Quando a foto é de uma NFC-e, o bot confere a chave (dígito verificador), consulta a nota no portal da SEFAZ do estado (2 primeiros dígitos da chave; URLs da tabela do ACBr em `Sefaz.js`) e a IA lê o texto da página. Itens, quantidades, valor pago e forma de pagamento passam a ser os oficiais; a foto vira só o ponto de partida.

- O rascunho aparece na hora com o que veio da foto ("Buscando a nota na SEFAZ…") e se atualiza sozinho ("Itens conferidos na SEFAZ").
- Se a SEFAZ falhar (fora do ar, captcha, página que depende de JavaScript), fica o que foi lido da foto, com o motivo no rascunho. O motivo também aparece nos registros de execução.
- O portal do RN (nfce.sefaz.rn.gov.br) só atende acessos de dentro do Brasil (testado a partir do Google e do GitHub em 23/10/2026); para notas do RN o bot nem tenta e fica com a foto. Propriedade `SEFAZ_RN_DIRETO = 1` reativa a tentativa, se um dia liberarem.
- Também funciona sem foto: compartilhe o link do QR code (lido pela câmera) com o bot ou digite a chave de 44 dígitos.

### Histórico de preços

Cada item do cupom vai para a aba **Itens** da planilha, ligado ao lançamento: produto com nome padronizado, marca, categoria do item (ex.: "Mercearia > Arroz"), quantidade, unidade, preço unitário já com o desconto rateado, loja, data e chave da NFC-e. Desfazer apaga os itens junto.

- `/preco arroz` ou "onde o café está mais barato?": lojas do menor preço médio para o maior (12 meses) e as últimas compras.
- A busca aceita produto, marca ou categoria do item (ex.: `/preco mercearia`).

## Notificações do Android (Fase 2)

O MacroDroid captura a notificação de compra do banco e manda ao bot. A compra já entra na planilha com status **revisar** (aparece em "Para revisar" no app) e o rascunho aparece no Telegram de quem gastou: Confirmar atualiza esse mesmo lançamento, Cancelar apaga. Se você revisar pelo app primeiro, o Telegram avisa que já foi resolvido. Transferências entre suas contas continuam só no Telegram até você confirmar.

- Lê: compras no cartão XP e Itaú/iti, Pix enviados pela XP, Carteira do Google e vale Pluxee.
- Ignora boletos, avisos e promoções.
- A mesma compra avisada por dois apps (banco + Carteira do Google) vira um rascunho só.
- O cartão ou conta sai da sigla no fim do nome (41 cred XP, 42 cred ITI, 05 cc XP, 04 vr PX).
- Pix para o seu próprio nome vira **transferência entre contas**; quando o outro banco avisa "Pix recebido de você", o destino é preenchido sozinho. Pix recebido de outra pessoa vira receita.
- Nomes extras que contam como "você" (ex.: nome completo): propriedade `NOMES_PROPRIOS`, como `["Willyam Brito"]`.
- Rode `testarNotificacoes` para ver como cada exemplo é lido e `instrucoesMacroDroid` para pegar o endereço de cada pessoa.

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

## Publicação automática

O workflow `.github/workflows/deploy-apps-script.yml` publica sozinho a cada push na `main`:
arquivos da raiz vão para o FlowFinance; a pasta `bot/` vai para o FlowFinance Bot, com nova versão na mesma implantação (a URL do webhook não muda).
Precisa dos segredos `CLASPRC_JSON` e `BOT_DEPLOYMENT_ID` no GitHub (veja o topo do workflow).
O Apps Script guarda no máximo 200 versões por projeto; se chegar perto disso, apague versões antigas em Implantar › Gerenciar implantações.

