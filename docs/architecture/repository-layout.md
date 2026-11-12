# Project Hub kaynak ve runtime mimarisi

## Temel sınır

`PROJECTHUB/` dağıtılabilir ürünün kaynak deposudur. Yönetilen kullanıcı projeleri, build çıktıları, veritabanı
dosyaları, yüklemeler, loglar ve geçici çalışma kopyaları bu ağacın içine girmez. Yerel geliştirmede bunların tamamı
kardeş `PROJECTHUB_RUNTIME/` dizininde; üretimde ise ayrı bir kalıcı disk/volume üzerinde tutulur.

```text
PROJECTHUB/                       # Git deposu: yalnızca ürün kodu
  apps/
    web/                          # Next.js kullanıcı arayüzü; API'ye /api üzerinden bağlanır
    api/                          # HTTP, kimlik/yetki, iş kuralları ve PostgreSQL işlemleri
    worker/                       # Kuyruktaki build, AI, preview, tarama ve deploy işleri
  packages/
    contracts/                    # API/manifest şemaları; web-api-worker ortak sözleşmesi
    core/                         # Git, storage, güvenlik, kuyruk ve ortak domain servisleri
    database/                     # Drizzle şeması ve sıralı migration'lar
  deploy/                         # Container/Compose üretim tanımı
  docs/                           # Mimari, ADR ve işletim dokümanı
  scripts/                        # Geliştirme ve operatör komutları

PROJECTHUB_RUNTIME/               # Git ve image build context'i dışında
  postgres/                       # Yalnızca yerel embedded PostgreSQL cluster'ı
  storage/
    repos/                        # Yönetilen projelerin bare Git depoları; tek kalıcı kaynak kopyası
    artifacts/                    # Doğrulanmış build paketleri ve üretilen raporlar
    backups/                      # Proje veritabanı yedekleri
    logs/                         # Build/preview/deploy logları
    uploads/                      # Tamamlanmamış, süreli import yüklemeleri
    workspaces/                   # Geçici build/AI/deploy/terminal checkout'ları
    tmp/                          # Paket cache'leri ve kısa ömürlü araç verisi
    deploy-local/                 # Yalnız geliştirme için yerel yayın hedefi
  tools/                          # Harici scanner binary'leri
  operator-backups/               # Tam sistem/readiness yedekleri; ayrı saklama politikasına uygun
  scratch/                        # Operatör inceleme kopyaları; uygulamanın kalıcı verisi değildir
  run/                            # PID/lock gibi süreç durumu
```

## Bağlantı ve veri akışı

1. `web`, yalnızca sürümlenmiş HTTP sözleşmesiyle `api`ye konuşur; veritabanına veya dosya sistemine erişmez.
2. `api`, PostgreSQL'de metadata/kimlik/yetki tutar ve uzun işleri transaction içinde kuyruğa yazar.
3. `worker`, işi kuyruktan sahiplenir; yönetilen bare repo'dan süreli bir workspace üretir, izole executor'da çalıştırır
   ve yalnız doğrulanmış çıktıyı artifact alanına taşır.
4. Preview ve deploy, kaynak checkout yerine immutable artifact tüketir. Secret'lar artifact'a yazılmaz; çalışma
   anında enjekte edilir.
5. PostgreSQL bağlantıları yalnız `DATABASE_URL` üzerinden backend servislerine verilir. Test adımı gerçek uygulama
   veritabanı secret'larını miras almaz; manifestteki izole `test.env` açıkça üstün gelir.

## Günlük kullanım

- İlk geçiş veya eski checkout temizliği: `pnpm runtime:migrate`
- Kaynak ağacına runtime verisi geri sızmış mı: `pnpm structure:check`
- Yerel veritabanı: `pnpm db:start`
- Uygulama: `pnpm dev`
- Doğrulama: `pnpm typecheck` ve ilgili testler

Yedekleme sınırı nettir: PostgreSQL mantıksal yedeği ile `PROJECTHUB_RUNTIME/storage` birlikte korunur; tam sistem
yedekleri `operator-backups` altında ayrı saklama süresine sahiptir. `workspaces`, `tmp`, `scratch` ve `run` yeniden
üretilebilir olduğu için uzun süreli yedeğe dahil edilmez.
