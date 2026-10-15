FROM python:3.11-alpine
WORKDIR /app
COPY . /app
ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "server.py"]
