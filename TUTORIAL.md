# Tutorial — operando o Pouch

Guia prático da aba **Estratégias**, que é de onde tudo é ligado, configurado e
escolhido. Cada opção está explicada: o que é, para que serve e como decidir o
valor.

Se você quer só ver a cara da coisa antes de configurar nada, abra
`http://127.0.0.1:8777/demo` — a mesma tela com números inventados.

---

## Do zero ao robô rodando, em seis passos

1. Crie chaves de teste em <https://testnet.binance.vision> (entre com o GitHub,
   clique em *Generate HMAC_SHA256 Key*). A conta já vem com USDT fictício.
2. `cp .env.example .env` e cole as duas chaves lá dentro.
3. `python run.py` — o painel abre em <http://127.0.0.1:8777>.
4. Na barra da esquerda, **Conta** precisa estar verde. Se estiver vermelha, as
   chaves não foram aceitas.
5. Vá em **Estratégias → Estado da busca → Rodar uma nova varredura**. Leva de
   alguns minutos a dezenas, conforme o que você pediu.
6. No **Ranking**, marque as linhas com o selo `aprovada`, clique em **Operar
   selecionadas**, e ligue o robô no cartão do topo.

O robô se recusa a ligar sem estratégia alocada, e diz isso em vez de ligar
sem fazer nada.

---

## Os três pontinhos da barra lateral

Três coisas diferentes podem estar quebradas, e de fora se parecem: em todas,
nada acontece.

| | Verde | Não verde |
|---|---|---|
| **Mercado** | preços públicos chegando | sem conexão — nada pode ser calculado |
| **Conta** | chaves aceitas, dá para ver saldo e enviar ordem | ausentes ou recusadas — não opera |
| **Robô** | acordando a cada ciclo, lendo sinais | âmbar: parado, nenhum sinal sendo lido |

---

## Seção OPERAÇÃO

### Robô — livro validado

O motor. Lê o sinal na última vela **fechada** de cada alocação e decide entrada
e saída. Nunca age na vela que ainda está se formando — ela ainda pode mudar de
ideia, e um backtest que age nela inventa lucro que a vida real não entrega.

A linha de fatos abaixo do texto mostra, sem abrir nada, o que importa saber
antes de ligar:

```
testnet      $200           3                  $600            60s
modo         por operação   posições no máx.   no teto         entre ciclos
```

**`$600 no teto`** é valor × posições. É a conta que ninguém faz de cabeça na
hora de apertar o botão, e é quanto do seu caixa pode estar comprometido ao
mesmo tempo.

#### ▸ Configurar a operação

| Campo | O que é | Como decidir |
|---|---|---|
| **Modo** | `Testnet` envia ordens assinadas de verdade para a conta que sua chave abrir. `Papel` simula o preenchimento e **não envia nada a lugar nenhum** | Comece em papel se quiser só observar. Testnet quando quiser exercitar o caminho real da ordem |
| **Intervalo entre ciclos** | De quantos em quantos segundos o robô acorda e olha os sinais | 60s serve para tudo aqui. As estratégias operam em velas de 4h e 1d — acordar mais rápido não descobre nada mais cedo, só gasta chamada de API |
| **Valor por operação** | Quanto de USDT entra em cada posição | Precisa ser maior que o mínimo da corretora (normalmente ~$10). Multiplique pelo teto de posições e veja se cabe no seu saldo |
| **Máx. posições simultâneas** | Quantas moedas o robô pode segurar ao mesmo tempo | Se você tem 17 alocações e teto de 3, as 14 restantes ficam esperando vaga. Um teto baixo demais transforma alocação em sorteio de quem disparou primeiro |
| **Capital de referência** | A base sobre a qual todo retorno é calculado | **Não é um dial.** Ele está dentro de cada foto de patrimônio, então mudá-lo move a curva inteira — o sistema avisa e rebaseia o histórico quando você muda |

**Rodar um ciclo agora** — força uma passada imediata sem esperar o intervalo.
Útil para ver se está tudo respondendo.

**Zerar histórico** — apaga posições, ordens, patrimônio e eventos. Pede
confirmação. **Não fecha nada na corretora**: posições abertas continuam lá, só
somem do registro daqui.

> ⚠️ Zerar o histórico também zera a contagem de paridade e de presença nas
> velas. Os portões do Painel voltam do zero.

### Estratégias em operação

As alocações ativas: moeda, estratégia, tempo gráfico, parâmetros e risco de
cada uma. Uma linha por alocação, com botão de remover.

**Uma alocação por moeda, sempre.** Duas estratégias na mesma moeda brigariam
pelo mesmo saldo — na conta spot, as duas são donas do mesmo BTC, e a que vende
pode vender as moedas da que segura.

### Risco da carteira

Todos vêm **desligados**, e isso é uma decisão medida, não preguiça: stop por
operação foi testado nas 31 estratégias aprovadas e **nenhuma** melhorou com
stop puro. Os controles abaixo agem sobre a carteira inteira, onde não competem
com a regra de saída de cada estratégia.

| Controle | O que faz | Como configurar |
|---|---|---|
| **Parar de abrir com queda de** | Acima dessa queda desde o pico, o robô para de **abrir** posições novas. As abertas mantêm as próprias saídas | 20% é o valor de referência — cerca de 1,7× o pior trimestre esperado, então dispara quando algo quebrou, não numa má fase normal. `0` = desligado |
| **Voltar a abrir ao recuperar para** | A trava só solta quando a recuperação passa deste valor | Tem de ser **menor** que o de cima, senão a trava fica ligando e desligando a cada oscilação |
| **Correlação máxima entre posições** | Recusa entrada em moeda muito correlacionada com alguma já aberta | `0` = desligado. `0,8` é restritivo em cripto, onde quase tudo anda junto |
| **Ajustar tamanho pela volatilidade** | Escala a ordem pela volatilidade recente, entre 0,4× e 1,6× | Ligue se quiser que um valor fixo signifique o mesmo risco numa moeda calma e numa violenta |

> Fechar tudo no fundo é exatamente o comportamento que o estudo de stops mediu
> como destrutivo. Por isso a trava impede abrir, e nunca força fechar.

---

## Seção DADOS DE MERCADO

### Coleta de contexto

Grava financiamento, posicionamento, medo-e-ganância e manchetes — com a hora em
que **este processo** recebeu o dado, não a hora que a fonte declara.

Parece um detalhe e é a coisa toda. Se você baixar hoje o histórico de
posicionamento e disser *"em 3 de maio o mercado estava esticado"*, está usando
um número revisado depois de 3 de maio. Um modelo treinado nisso lê o jornal de
amanhã, brilha no backtest e quebra ao vivo.

**Nada aqui prevê nada hoje.** A coleta existe porque posicionamento e manchetes
têm retenção de poucos dias — só existem daqui para frente. Se ninguém gravar, o
período não volta.

| Interruptor | Ligado | Desligado |
|---|---|---|
| **Coleta de contexto** | grava as cinco fontes nas cadências delas | o período parado fica faltando **para sempre** nas fontes sem histórico |
| **Pontuação FinBERT** | pontua cada manchete no instante em que chega | manchetes continuam sendo gravadas, só ficam sem nota — e libera ~500 MB de memória |

A barra mostra quanto do **primeiro ano** já passou. Um ano é o mínimo para
testar essas séries com honestidade. O relógio conta do primeiro registro que
este processo escreveu — nunca do carimbo da fonte, que para financiamento
alcança 2020 e diria que está tudo pronto no dia da instalação.

**Se a máquina é pequena:** deixe a coleta ligada e o FinBERT desligado. Você
preserva o dado irrecuperável e devolve meio giga. A manchete é irrecuperável; a
nota dela pode ser recalculada depois.

---

## Seção DESCOBERTA

### Estado da busca

O que a busca **já gastou**. `Candidatos testados` é o número mais importante da
seção, e o motivo é estatístico:

> Testar 13 estratégias × centenas de parâmetros × dezenas de moedas vai aprovar
> algumas por puro acaso. É o mesmo motivo pelo qual, jogando mil moedas dez
> vezes cada, alguma dá dez caras seguidas.

Cada varredura nova amplia esse número e, com ele, a chance de uma `aprovada`
ter passado por sorte.

#### ▸ Rodar uma nova varredura

| Campo | O que é | Como decidir |
|---|---|---|
| **Pares** | Quais moedas varrer, separadas por vírgula | Mais moedas encontram mais coisa: reversão à média foi de 0,6% para 9,2% de aprovação só ampliando de 5 para 20 moedas. Mas cada moeda multiplica o tempo e o orçamento de comparações |
| **Tempos gráficos** | `1d`, `4h`, `1h`, `15m` | **Use `1d`, e `4h` no máximo.** O diário aprova 11,4% contra 5,6% do 4h. Uma ida e volta custa 0,30% e a vela mediana de 15 min anda 0,122% — não paga a operação que a atravessa |
| **Histórico por par** | Quantas velas baixar | 3000 velas de `1d` são ~8 anos; de `1h`, 4 meses. O limite é de contagem, não de tempo, então tempo gráfico rápido = janela curta = um regime só |

**Quando vale rodar de novo:**

- ✅ moedas novas que nunca foram varridas
- ✅ passaram meses e a fatia fora da amostra virou dado de verdade
- ✅ o catálogo de estratégias mudou
- ❌ as mesmas moedas uma semana depois — não é evidência nova, é o mesmo
  sorteio outra vez

### Ranking

Uma linha por candidata, ordenada por score fora da amostra.

| Coluna | O que é |
|---|---|
| **Retorno OOS** | Quanto rendeu na fatia que o ajuste **nunca viu**. É a única nota que vale |
| **Buy & hold** | Quanto teria rendido só comprando e segurando na mesma janela. Se a estratégia não supera isso, não serve |
| **Sharpe** | Retorno por unidade de risco. Acima de 0,3 é o piso |
| **Drawdown** | A pior queda desde um pico durante o teste |
| **Trades** | Quantas operações. Poucas = resultado que pode ser uma só sorte |
| **Score** | Nota combinada, que penaliza amostra pequena, queda profunda e vantagem vinda de um trecho de sorte |

O selo diz o veredito:

- **`aprovada`** — passou nos cinco portões: lucro fora da amostra, Sharpe acima
  do piso, pelo menos 3 operações, superou comprar-e-segurar, e deu lucro em
  metade dos oito sub-períodos
- **`parcial`** — bateu comprar-e-segurar mas falhou em algo
- **`reprovada`** — não passou

A caixa **só aprovadas fora da amostra** filtra o resto. Clique numa linha para
ver a curva contra o benchmark. Marque e clique em **Operar selecionadas** para
promover ao livro ao vivo.

> Um ranking é uma lista de sobreviventes, e sobreviventes de uma busca grande
> são em parte sobreviventes de sorte. Trate `aprovada` como *evidência que
> merece ser testada adiante*, não como descoberta. Quem decide de verdade são
> os seis portões do Painel.

### Catálogo de estratégias

Referência: as 13 estratégias, a família de cada uma, quantas combinações de
parâmetro a varredura testa e o que cada uma faz. Você abre uma vez, quando um
nome do ranking não diz nada.

---

## Os seis portões do Painel

A faixa no topo do Painel responde a uma pergunta só: **este robô já merece
dinheiro de verdade?** Ela termina em **NÃO CONFIÁVEL** (vermelho) ou
**CONFIÁVEL** (verde).

Enquanto estiver vermelho, os números da tela são reais mas **não constituem
evidência** — nem de que a vantagem existe, nem de que o motor executa o que foi
medido.

| Portão | Fecha quando | Prazo realista |
|---|---|---|
| **validação** | todas as alocações passam nas janelas móveis | imediato |
| **paridade** | 10 operações idênticas ao backtest | semanas |
| **presença** | 90% dos fechamentos de vela cobertos | ~1 mês sem desligar |
| **amostra** | 100 operações **e** 270 dias | ~9 meses |
| **previsto** | realizado dentro da faixa prevista no deploy | junto com o anterior |
| **rebaixamento** | queda observada dentro do limite configurado | depende da trava estar ligada |

Eles são **conselho, não trava** — nada no código impede uma ordem porque a
faixa está vermelha. O que eles impedem é você confundir *"está dando lucro"*
com *"está validado"*.

---

## Perguntas rápidas

**Liguei o robô e nada acontece.** Normal. As estratégias operam em velas de 4h
e 1d e ficam paradas a maior parte do tempo. Confira o pontinho **Robô** verde
na lateral e o contador de ciclos.

**Por que o patrimônio não bate com o saldo da corretora?** O patrimônio parte
do capital de referência que você configurou e soma só o que **este robô** ganhou
ou perdeu. O saldo é a conta real, que começou com outro valor, tem operações
anteriores, e cai pelo valor cheio da ordem enquanto a posição está aberta —
esse dinheiro virou moeda, e o patrimônio segue contando a moeda a preço de
mercado.

**Mudei o capital de referência e a curva toda mudou.** Esperado. O capital está
dentro de cada foto de patrimônio; o sistema rebaseia o histórico e registra a
mudança no log.

**Quero operar com dinheiro de verdade.** `BINANCE_TESTNET=false` no `.env`
aponta toda ordem para a corretora real. Leia a seção *Indo para dinheiro de
verdade* do [README](README.md) antes. Chave nova, restrita a spot, saque
desabilitado, IP travado.
