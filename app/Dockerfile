FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /srv

COPY combined_cacerts.pem /etc/ssl/certs/combined_cacerts.pem
ENV SSL_CERT_FILE=/etc/ssl/certs/combined_cacerts.pem \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/combined_cacerts.pem \
    PIP_CERT=/etc/ssl/certs/combined_cacerts.pem

RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "sales_agent.main:app", "--host", "0.0.0.0", "--port", "8000"]
