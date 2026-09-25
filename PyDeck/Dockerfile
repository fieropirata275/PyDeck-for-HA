ARG BUILD_FROM=python:3.13-slim
FROM ${BUILD_FROM}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/*

COPY app/requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/requirements.txt

COPY app/ /app/
COPY web/ /web/
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8099
CMD ["/run.sh"]
