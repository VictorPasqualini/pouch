# Pouch

Um robô de trading de criptomoedas com painel web local — e, mais do que isso,
uma máquina de descobrir se ele realmente funciona.

O nome é a bochecha do hamster, e o mascote é a descrição honesta do motor: ele
fica parado por semanas, enfia uma posição na bochecha quando o preço está
errado, e esvazia a bochecha quando o preço está certo. As estratégias operam em
velas de 4 horas e 1 dia, e não fazem quase nada quase o tempo todo.

![stack](https://img.shields.io/badge/python-3.11%2B-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## O problema que este projeto ataca

A maioria dos robôs de trading entrega uma estratégia e assume que ela funciona.
Este parte da premissa oposta:

> **Quase nada funciona, e a parte difícil é distinguir o que funciona do que
> teve sorte.**

É fácil entender por quê. Se você testar mil estratégias no histórico do
Bitcoin, algumas vão parecer brilhantes — não porque descobriram algo, mas
porque mil tentativas produzem sortudos. É o mesmo motivo pelo qual, jogando
mil moedas dez vezes cada, alguma vai dar dez caras seguidas.

Então quase tudo aqui é maquinaria para não se enganar.

---

## Como funciona, em cinco passos

```
  histórico real de preços (API pública da Binance)
        │
        ▼
  1. VARREDURA      testa 13 estratégias × centenas de parâmetros
        │           ajustando nos 65% mais antigos do histórico
        ▼
  2. VALIDAÇÃO      pontua só nos 35% que o ajuste nunca viu
        │           reprova o que não continuar lucrativo ali
        ▼
  3. JANELAS        recoloca a sobrevivente no passado, trimestre
        │           a trimestre, sem reajustar nada
        ▼
  4. OPERAÇÃO       roda as aprovadas na Binance Spot Testnet
        │           (API real, livro de ofertas real, dinheiro fake)
        ▼
  5. CONFERÊNCIA    compara cada operação real com a que o
                    backtest teria feito nas mesmas velas
```

### Por que a divisão do passo 2 importa

Qualquer estratégia pode ser ajustada até parecer genial **nos dados usados
para ajustá-la**. Esse número não vale nada.

Uma analogia: se você decorar as respostas de uma prova e depois fizer a mesma
prova, tirar dez não prova que você aprendeu. A nota só significa algo numa
prova que você não viu antes.

Por isso o motor nunca classifica usando os dados contra os quais otimizou. Os
parâmetros são ajustados na fatia antiga; a nota vem da fatia recente, que o
otimizador nunca tocou.

Uma candidata só é marcada **aprovada** quando, na fatia retida, ela:

- dá lucro,
- tem retorno ajustado ao risco acima de um mínimo,
- fez pelo menos 3 operações,
- **supera simplesmente comprar e segurar** na mesma janela, e
- dá lucro em pelo menos metade de oito sub-períodos.

Esse último item — consistência — é o que separa uma vantagem repetível de uma
alta de sorte.

### O backtest é deliberadamente pessimista

Um backtest otimista é pior que nenhum, porque ele dá confiança falsa. Então:

- a decisão tomada no fechamento de uma vela só é executada na **abertura da
  vela seguinte** — nenhum sinal consegue negociar no preço que ele mesmo viu;
- quando uma vela toca o stop e o alvo, assume-se que o stop veio primeiro;
- **custo é cobrado dos dois lados** de toda operação: 0,1% de taxa mais 0,05%
  de escorregamento, e o robô cobra o mesmo, para os números continuarem
  comparáveis;
- o robô lê o sinal só em **velas fechadas**, nunca na que ainda está se
  formando.

---

## As estratégias

Treze, em cinco famílias. Cada uma é uma regra simples e mecânica — nenhuma
tenta adivinhar notícia, opinião ou narrativa.

### Tendência — "compre o que já está subindo"

| Estratégia | A ideia, em uma frase |
|---|---|
| **EMA Crossover** | Compra quando a média curta cruza acima da longa. O jeito mais antigo de dizer "a tendência virou". |
| **MACD Trend** | Fica comprado enquanto a diferença entre duas médias estiver crescendo. |
| **Supertrend** | Segue a tendência com uma faixa que se alarga quando o mercado fica agitado. |
| **ADX Filtered Trend** | Igual à primeira, mas só entra quando o mercado tem direção de verdade — ignora lateralização. |

### Rompimento — "compre quando sair da caixa"

| Estratégia | A ideia, em uma frase |
|---|---|
| **Donchian Breakout** | Compra quando o preço supera a máxima das últimas N velas. |
| **Bollinger Breakout** | Compra quando o preço escapa da faixa de volatilidade normal dele. |

### Reversão — "compre o que caiu demais"

| Estratégia | A ideia, em uma frase |
|---|---|
| **Bollinger Mean Reversion** | Compra quando o preço se estica muito abaixo da média, apostando na volta. |
| **RSI Mean Reversion** | Compra na sobrevenda, vende na recuperação. |
| **Stochastic Reversion** | Compra quando o preço começa a virar para cima a partir do fundo. |
| **Rolling VWAP Reversion** | Compra quedas abaixo do preço médio ponderado por volume. |

### Momento e conjunto

| Estratégia | A ideia, em uma frase |
|---|---|
| **Momentum (ROC)** | Compra o que subiu nos últimos N dias, com filtro de volatilidade. |
| **Ensemble Vote** | Só fica comprado quando várias das outras concordam. |

### A régua

| Estratégia | A ideia, em uma frase |
|---|---|
| **Buy & Hold** | Comprar e não fazer mais nada. É a barra que toda estratégia precisa superar — se não superar, não serve para nada. |

---

## O que a pesquisa realmente encontrou

Medido em dois estudos: 540 candidatas em 5 moedas grandes, depois 1440 em 20
moedas. "Taxa de validação" é quanto sobreviveu fora da amostra.

| Família | 5 moedas | 20 moedas | Alfa mediano |
|---|---|---|---|
| Momento | 11,1% | 12,5% | +8,6pp |
| Rompimento | 12,2% | 9,6% | **+25,1pp** |
| Reversão | **0,6%** | **9,2%** | +22,1pp |
| Conjunto | 6,7% | 8,3% | +16,9pp |
| Tendência | 6,1% | 6,2% | +19,4pp |

Três conclusões que vale internalizar antes de confiar em qualquer ranking:

**1. Quais moedas você negocia importa mais que qual estratégia você usa.** Em
BTC, ETH, BNB, SOL e XRP, reversão à média validou uma vez em 180 tentativas e
parecia definitivamente morta. Ampliando para 20 moedas, foi de 0,6% para 9,2%.
Nada nas estratégias mudou. A primeira conclusão não estava errada sobre os
dados — estava errada sobre até onde eles se generalizavam.

**2. Estratégias ganham em mercado lateral, não em alta nem em queda.** Uma
queda numa direção só não oferece nada para uma estratégia comprada pegar, e uma
alta implacável não pode ser batida por nada que às vezes fica em caixa.
Vantagem mora onde há oscilação para negociar.

**3. Velas diárias batem intradiárias.** `1d` validou em 11,4% contra 5,6% do
`4h`. Uma ida e volta custa 0,30%; a vela mediana de 15 minutos anda 0,122%. Na
janela rápida, a maioria das velas não consegue pagar a operação que a atravessa.

### A descoberta mais importante

Agrupando as 136 janelas trimestrais por que tipo de mercado aconteceu nelas:

| Mercado | Janelas | Lucrativas | Bateu comprar-e-segurar | Retorno mediano | Comprar-e-segurar |
|---|---|---|---|---|---|
| Alta | 31 | 87% | **6%** | +19,3% | +89,4% |
| Baixa | 46 | 52% | **100%** | +3,0% | −46,4% |
| Lateral | 59 | 80% | 80% | +9,4% | −1,2% |

Leia com atenção, porque isto define o que este robô é:

> **Ele não é um jeito de ganhar mais numa alta.** Numa alta ele captura um
> quinto do movimento e perde para simplesmente segurar em catorze janelas de
> quinze. O que ele faz é ficar de zero a positivo durante a metade da história
> em que segurar perdeu 46%.

Essa é a vantagem inteira. Vale saber qual você tem antes que um mercado de alta
faça a estratégia parecer genial e um de baixa a faça parecer quebrada.

---

## Começando

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows
# source .venv/bin/activate     # macOS / Linux

pip install -r requirements.txt
cp .env.example .env            # cole suas chaves de teste aqui
python run.py
```

O painel abre em <http://127.0.0.1:8777>.

Chaves gratuitas de teste em <https://testnet.binance.vision> (entre com o
GitHub, clique em *Generate HMAC_SHA256 Key*). A conta já vem com USDT fictício.

```bash
python run.py check           # verifica conexão e chaves
python run.py research        # varredura pelo terminal
python run.py backtest BTCUSDT 1d supertrend
python run.py walkforward XRPUSDT 1d bollinger_breakout
```

---

## As abas do painel

Passo a passo de cada opção, com o que é e como decidir o valor:
**[TUTORIAL.md](TUTORIAL.md)**.

| Aba | Para que serve |
|---|---|
| **Painel** | Os seis portões numa faixa no topo — com o veredito **confiável / não confiável** — e o estado do dinheiro agora. Patrimônio, quanto cresceu, resultado mês a mês, posições abertas, de onde vem o resultado, e cada operação por moeda com exportação em CSV. |
| **Estratégias** | O centro de controle, em três seções. *Operação*: liga o robô, configura quanto ele move, quais estratégias rodam e com que risco. *Dados*: a coleta de contexto e a pontuação de manchetes, com o progresso do primeiro ano. *Descoberta*: a varredura, o ranking e o catálogo. |


---

## Indo para dinheiro de verdade

`BINANCE_TESTNET=false` no `.env` aponta toda ordem para a corretora real. **Não
mude isso porque um backtest ficou bonito.** Taxas, escorregamento, liquidez e
mudança de regime mordem bem mais forte em produção.

A aba **Validação** responde a pergunta diretamente. Seis condições, em dois
níveis que fecham em relógios diferentes:

**Nível de execução** — o motor faz o que o modelo diz?

| Portão | Exigência | Por quê |
|---|---|---|
| Operações idênticas ao modelo | 10 | Defeito de execução é sistemático: aparece nas duas ou três primeiras comparações, porque cada operação é confrontada com a gêmea dela, não diluída numa média |
| Presença nos fechamentos de vela | 90% | Vela dormida é invisível depois: "a estratégia nunca disparou" e "disparou sem ninguém ouvindo" deixam o mesmo registro vazio |

**Nível de evidência** — a vantagem ainda existe? Isso nenhuma execução
cuidadosa responde; só o tempo.

| Portão | Exigência | Por quê |
|---|---|---|
| Todas as alocações passam nas janelas móveis | todas | Um livro só é tão validado quanto o pior membro dele |
| Operações encerradas **e** dias operando | 100 **e** 270 | 270 dias são três trimestres completos, o mínimo para situar o realizado dentro da distribuição medida. 100 operações põem a taxa de acerto numa margem de ±10 pontos; com 30, a margem é ±18 e não separa nada |
| Realizado dentro da faixa prevista | acima do piso | A previsão foi congelada no dia do deploy e nunca é recalculada — uma expectativa refeita depois já contém o período que deveria julgar |
| Rebaixamento dentro do limite | 20% | Cerca de 1,7× o pior trimestre esperado, então dispara quando algo quebrou, não durante uma má fase normal |

---

## O que este projeto não é

Ser honesto sobre isso é metade do ponto:

- **Não é garantia de lucro.** Operar cripto pode perder dinheiro, e este robô
  também.
- **Não bate comprar-e-segurar num mercado de alta.** Está medido acima e não é
  acidente: é o que uma estratégia que às vezes fica em caixa faz.
- **Um ranking é uma lista de sobreviventes**, e sobreviventes de uma busca
  grande são em parte sobreviventes de sorte. Trate resultado validado como
  *evidência que merece ser testada adiante*, não como descoberta.
- **Só compra.** Não vende a descoberto, então é estruturalmente exposto à
  cripto. Bater comprar-e-segurar é difícil justamente porque a régua é a mesma
  aposta.

O registro completo das decisões, medições e becos sem saída está em
[ROADMAP.md](ROADMAP.md).

---

## Estrutura

```
bot/
  strategies.py    as 13 estratégias e as grades de parâmetros
  backtest.py      o simulador, deliberadamente pessimista
  research.py      a varredura: otimiza no antigo, pontua no recente
  walkforward.py   recoloca no passado, trimestre a trimestre
  live.py          o motor que opera de verdade
  exchange.py      cliente REST da Binance
  parity.py        cada operação real contra a gêmea do backtest
  coverage.py      em quais fechamentos de vela o robô estava vivo
  tracking.py      o realizado contra a previsão congelada
  portfolio.py     risco no nível da carteira
  feeds.py         contexto de mercado, gravado na hora em que chegou
  sentiment.py     pontuação de manchetes com FinBERT
  report.py        o que o painel lê
  api.py           API JSON + o painel estático
web/               painel sem etapa de build
```

## Licença

MIT. Use por sua conta e risco — isto não é consultoria financeira.
