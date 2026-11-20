# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Gestor de tráfego e a equipe dele (confirmado: "eu e minha equipe"), que criam anúncios em vídeo para campanhas de redes sociais (Meta). Pessoas diferentes usam o painel, então a tela precisa se explicar sozinha, sem depender de quem já conhece as funções. Usam no computador e no celular (confirmado: "os dois"). O trabalho típico é gerar de 12 a 50 variações por vez a partir de poucos clipes.

## Product Purpose

Transformar poucos vídeos (ganchos, corpos e CTAs) em muitas variações de criativo prontas para testar em anúncios, sem editor de vídeo. Sucesso é sair do upload dos clipes até as variações prontas para baixar, com legenda, texto na tela e volume consistente, em poucos cliques e sem esquecer nenhuma etapa.

## Positioning

Combina automaticamente todos os ganchos com todos os corpos e CTAs, trata cada clipe uma vez (corte e volume) e aplica legenda, texto na tela e corte de pausas em lote, tudo rodando no servidor próprio da equipe, sem API paga de IA.

## Operating Context

Fluxo em ordem: 1) subir os clipes de gancho, corpo e CTA; 2) tratar cada clipe (cortar início e fim, "OK, próximo") e equalizar o volume entre todos; 3) gerar as variações; 4) editar as variações selecionadas (legenda, texto na tela, corte de pausas, partes e volume) e baixar. Referências são vídeos cujo estilo (legenda, texto, corte de pausas) a equipe quer copiar. Roda em servidor próprio (Docker/EasyPanel) com senha de acesso; os dados ficam em um volume.

## Capabilities and Constraints

- Idioma da interface: português do Brasil. Termos do domínio: gancho, corpo, CTA, variação, legenda, texto na tela, referência, tratamento, equalizar, cortar pausas, partes.
- Tudo local: ffmpeg e Whisper no servidor, fontes embutidas (Poppins, Montserrat, Anton, Bebas Neue, Archivo Black, Bangers). Sem chamada a APIs externas de IA.
- Trabalhos longos (conversão, corte, transcrição, render) mostram progresso real e podem ser cancelados.
- Estado salvo no servidor (volume /data); há aviso quando o volume não é permanente.
- Arquivo único `public/index.html` (HTML, CSS e JS sem framework), servido por Express; IDs e comportamento dos elementos já existentes devem continuar funcionando.
- Formato de saída fixo: vertical 1080x1920.

## Product Principles

- O fluxo é linear e a tela mostra em que etapa a pessoa está e qual é o próximo passo.
- Nada de etapa esquecida: o que falta fica visível e bloqueia o passo seguinte quando necessário.
- Ações em lote são o caminho principal (12 a 50 variações), com a seleção sempre clara.
- Quem nunca usou entende cada controle pelo rótulo e pelo contexto, sem manual.
- O resultado (os vídeos) é o protagonista; o resto da interface recua.

## Evidence on Hand

Sem imagens de marca, logo, depoimentos ou métricas. Não inventar nenhum. Nome do produto ainda não definido: o título atual é "Variações de Criativo".
