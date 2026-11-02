import {createOperatorAccess} from './operator-auth.mjs';
import cors from "cors";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import sharp from "sharp";
import { PDFDocument as UploadedPdfDocument } from "pdf-lib";
import {
  analyzeDniBarcodeText,
  analyzeDniText,
  hasUsefulDniFields,
  validateDniRead,
  validateArgentineCuil,
} from "./dni-ocr.mjs";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import { renderDocx, renderPdfFromDocx } from "./docx-generators.mjs";
import { renderPdf as renderFastPdf } from "./pdf-generators.mjs";
import { pool, pingDatabase } from "./db.mjs";

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});

process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error);
});

const app = express();
const port = Number(process.env.PORT || 3000);
const storageDir = process.env.STORAGE_DIR || path.resolve("storage");
const ocrTimeoutMs = Number(process.env.OCR_TIMEOUT_MS || 90000);
const ocrAttemptTimeoutMs = Number(process.env.OCR_ATTEMPT_TIMEOUT_MS || 10000);
const ocrRateLimitWindowMs = Number(process.env.OCR_RATE_LIMIT_WINDOW_MS || 60000);
const ocrRateLimitMax = Number(process.env.OCR_RATE_LIMIT_MAX || 10);
const ocrSpaceEnabled = false; // External OCR providers are excluded.
let ocrWorkerPromise;
let ocrWorkerQueue = Promise.resolve();
let mrzOcrWorkerPromise;
let mrzOcrWorkerQueue = Promise.resolve();

fs.mkdirSync(storageDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, storageDir),
    filename: (_req, file, callback) => {
      const ext = path.extname(file.originalname || "");
      const safeExt = ext.replace(/[^a-z0-9.]/gi, "").slice(0, 12);
      callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});

app.use(cors({ origin: parseCorsOrigin(process.env.CORS_ORIGIN) }));
app.use(express.json({ limit: "2mb" }));

// Local credentials are supplied by the user, never inherited from the customer.
app.use(createOperatorAccess({username:process.env.OPERATOR_USER,password:process.env.OPERATOR_PASSWORD}));
app.use(express.static(path.resolve('../app')));


await ensureRuntimeSchema();

app.get("/health", async (_req, res) => {
  try {
    await pingDatabase();
    res.json({ ok: true, database: "up" });
  } catch (error) {
    res.status(503).json({ ok: false, database: "down", error: error.message });
  }
});

app.get("/api/reservations", async (_req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, tenant_title, tenant_full_name, tenant_dni, property_address, advisor, created_at, updated_at
       FROM reservations
       ORDER BY updated_at DESC, id DESC
       LIMIT 100`,
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get("/api/reservations/:id", async (req, res, next) => {
  try {
    const reservation = await findById("reservations", req.params.id);
    if (!reservation) return res.status(404).json({ error: "reservation_not_found" });

    const operation = await findOne("operations", "reservation_id", req.params.id);
    const guarantors = await findMany("guarantors", "reservation_id", req.params.id);

    res.json({ reservation, operation, guarantors });
  } catch (error) {
    next(error);
  }
});

app.get("/api/properties", async (_req, res, next) => {
  try {
    const [reservationRows] = await pool.query(
      `SELECT r.*, o.id AS operation_id, o.receipt_number, o.reservation_date,
              o.reservation_amount, o.reservation_amount_words, o.reports_amount,
              o.reports_amount_words, o.landlord_title, o.landlord_full_name, o.landlord_dni,
              o.landlord_cuil, o.landlord_email, o.contract_number,
              o.contract_start, o.contract_end, o.copy_count
       FROM reservations r
       LEFT JOIN operations o ON o.reservation_id = r.id
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT 200`,
    );
    const [guarantorRows] = await pool.query(
      `SELECT *
       FROM guarantor_submissions
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
    );
    const [documentRows] = await pool.query(
      `SELECT id, property_address, actor, document_type, original_name, stored_name,
              mime_type, size_bytes, created_at
       FROM documents
       ORDER BY created_at DESC, id DESC
       LIMIT 1000`,
    );

    res.json(groupByProperty(reservationRows, guarantorRows, documentRows));
  } catch (error) {
    next(error);
  }
});

app.get("/api/documents", async (req, res, next) => {
  try {
    const propertyAddress = clean(req.query.propertyAddress);
    if (!propertyAddress) return res.status(400).json({ error: "property_address_required" });

    const [rows] = await pool.execute(
      `SELECT id, property_address, actor, document_type, original_name, stored_name,
              mime_type, size_bytes, created_at
       FROM documents
       WHERE property_address = :propertyAddress
       ORDER BY created_at DESC, id DESC`,
      { propertyAddress },
    );

    res.json(rows.map(withDocumentUrl));
  } catch (error) {
    next(error);
  }
});

app.post("/api/documents", upload.array("files", 10), async (req, res, next) => {
  try {
    const propertyAddress = clean(req.body.propertyAddress);
    const actor = clean(req.body.actor);
    const documentType = clean(req.body.documentType);
    if (!propertyAddress || !actor || !documentType) {
      return res.status(400).json({ error: "property_actor_type_required" });
    }
    if (!req.files?.length) return res.status(400).json({ error: "files_required" });

    const files = req.files || [];
    try {
      for (const file of files) {
        await validateUploadedDocumentFile(file);
      }
    } catch (error) {
      await Promise.all(files.map((file) => removeUploadedFile(file)));
      throw error;
    }

    const saved = [];
    for (const file of files) {
      const payload = {
        propertyAddress: clip(propertyAddress, 255),
        actor: clip(actor, 40),
        documentType: clip(documentType, 80),
        originalName: clip(file.originalname, 255),
        storedName: clip(file.filename, 255),
        mimeType: clip(file.mimetype, 120),
        sizeBytes: file.size,
      };
      const document = await withMysqlLock(documentLockKey(payload), async (connection) => {
        const existing = await findRecentDocumentDuplicate(connection, payload);
        if (existing) {
          await removeUploadedFile(file);
          return existing;
        }

        const [result] = await connection.execute(
          `INSERT INTO documents (
            property_address, actor, document_type, original_name,
            stored_name, mime_type, size_bytes
          ) VALUES (
            :propertyAddress, :actor, :documentType, :originalName,
            :storedName, :mimeType, :sizeBytes
          )`,
          payload,
        );
        return { id: result.insertId, ...snakeDocument(payload) };
      });
      saved.push(withDocumentUrl(document));
    }

    res.status(201).json({ documents: saved });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/ocr/dni",
  createRateLimiter({ windowMs: ocrRateLimitWindowMs, max: ocrRateLimitMax }),
  upload.array("files", 2),
  async (req, res, next) => {
    const files = req.files || [];
    const deadline = Date.now() + ocrTimeoutMs;
    try {
      if (!files.length) return res.status(400).json({ error: "files_required" });

      const candidates = [];

      await withTimeout(
        (async () => {
          if (!hasCompleteDniFields(mergeDniCandidates(candidates).fields) && remainingMs(deadline) > 1800) {
            const barcodeDeadline = Date.now() + Math.min(2200, remainingMs(deadline) - 250);
            for (const file of files) {
              if (remainingMs(barcodeDeadline) < 350) break;
              if (!String(file.mimetype || "").startsWith("image/")) {
                console.error("[ocr] non-image file skipped:", file.originalname);
                continue;
              }

              const filePath = path.join(storageDir, file.filename);
              try {
                candidates.push(...await recognizeDniBarcodes(filePath, barcodeDeadline));
                if (hasCompleteDniFields(mergeDniCandidates(candidates).fields)) break;
              } catch (error) {
                console.error("[ocr] barcode read skipped:", error?.message || error);
              }
            }
          }

          if (!hasCompleteDniFields(mergeDniCandidates(candidates).fields) && remainingMs(deadline) > 3000) {
            await withMrzOcrWorker(async (worker) => {
              for (const file of [...files].reverse()) {
                if (remainingMs(deadline) < 1500) break;
                if (!String(file.mimetype || "").startsWith("image/")) continue;

                const filePath = path.join(storageDir, file.filename);
                if (!await shouldTryMrzCrop(filePath)) continue;
                try {
                  const candidate = await recognizeFastDniMrz(worker, filePath, deadline);
                  if (candidate.score) candidates.push(candidate);
                  if (validDni(candidate.fields?.dni) && validCuil(candidate.fields?.cuil)) break;
                } catch (error) {
                  console.error("[ocr] fast MRZ read skipped:", error?.message || error);
                }
              }
            });

            if (files.length > 1 && remainingMs(deadline) > 6000) {
              await withOcrWorker(async (worker) => {
                for (const file of files) {
                  if (remainingMs(deadline) < 1200) break;
                  if (!String(file.mimetype || "").startsWith("image/")) continue;

                  const filePath = path.join(storageDir, file.filename);
                  try {
                    const candidate = await recognizeBestDniImage(worker, filePath, deadline, { maxAngles: 3, stopWhenIdentity: true });
                    candidates.push(candidate);
                    if (candidate.fields?.fullName && validDni(candidate.fields?.dni)) break;
                  } catch (error) {
                    console.error("[ocr] front identity read skipped:", error?.message || error);
                  }
                }
              });
            }

            await withMrzOcrWorker(async (worker) => {
              for (const file of [...files].reverse()) {
                if (remainingMs(deadline) < 900) break;
                if (!String(file.mimetype || "").startsWith("image/")) continue;

                const filePath = path.join(storageDir, file.filename);
                if (!await shouldTryMrzCrop(filePath)) continue;
                try {
                  candidates.push(await recognizeBestDniMrzCrop(worker, filePath, deadline));
                  if (hasCompleteDniFields(mergeDniCandidates(candidates).fields)) break;
                } catch (error) {
                  console.error("[ocr] MRZ crop skipped:", error?.message || error);
                }
              }
            });

            await withOcrWorker(async (worker) => {

              for (const file of files) {
                if (remainingMs(deadline) < 900) break;
                if (hasCompleteDniFields(mergeDniCandidates(candidates).fields)) break;
                if (!String(file.mimetype || "").startsWith("image/")) continue;

                const filePath = path.join(storageDir, file.filename);
                try {
                  candidates.push(await recognizeBestDniImage(worker, filePath, deadline));
                  if (hasCompleteDniFields(mergeDniCandidates(candidates).fields)) break;
                } catch (error) {
                  console.error("[ocr] unreadable image skipped:", error?.message || error);
                }
              }
            });
          }

          if (!hasUsefulDniFields(mergeDniCandidates(candidates).fields) && ocrSpaceEnabled && remainingMs(deadline) > 1800) {
            for (const file of files) {
              if (remainingMs(deadline) < 900) break;
              if (!String(file.mimetype || "").startsWith("image/")) continue;
              const filePath = path.join(storageDir, file.filename);
              const candidate = await recognizeWithOcrSpace(filePath, deadline);
              if (candidate) candidates.push(candidate);
            }
          }
        })(),
        ocrTimeoutMs,
        "ocr_timeout",
      ).catch((error) => {
        if (error?.message !== "ocr_timeout") throw error;
        console.error("[ocr] time budget exhausted; returning best partial result");
      });

      const text = candidates.map((candidate) => candidate.text).filter(Boolean).join("\n");
      const combinedAnalysis = analyzeDniText(text, "ocr");
      if (hasUsefulDniFields(combinedAnalysis.fields) || combinedAnalysis.fields.fullName) {
        candidates.push({
          text,
          fields: combinedAnalysis.fields,
          confidence: combinedAnalysis.confidence,
          warnings: combinedAnalysis.warnings,
          documentType: combinedAnalysis.documentType,
          source: "ocr",
          score: scoreDniCandidate(combinedAnalysis.fields, text, "ocr"),
        });
      }
      const merged = mergeDniCandidates(candidates);
      const { fields } = merged;
      if (!hasUsefulDniFields(fields)) {
        return res.status(422).json({
          error: "dni_not_readable",
          message: "No se pudo leer el DNI.",
          text,
          fields,
        });
      }

      const reliability = validateDniRead(fields);
      if (!reliability.ok) {
        return res.status(422).json({
          error: "dni_read_incomplete",
          message: "La lectura del DNI no fue suficientemente confiable.",
          text,
          fields,
          confidence: merged.confidence,
          warnings: [...merged.warnings, ...reliability.warnings],
          documentType: merged.documentType,
          sources: merged.sources,
        });
      }

      res.json({
        text,
        fields,
        confidence: merged.confidence,
        warnings: merged.warnings,
        documentType: merged.documentType,
        sources: merged.sources,
      });
    } catch (error) {
      next(error);
    } finally {
      await Promise.all(files.map((file) => removeUploadedFile(file)));
    }
  },
);

app.get("/api/documents/:id/download", async (req, res, next) => {
  try {
    const documentRow = await findById("documents", req.params.id);
    if (!documentRow) return res.status(404).json({ error: "document_not_found" });

    const filePath = path.join(storageDir, documentRow.stored_name);
    res.download(filePath, documentRow.original_name);
  } catch (error) {
    next(error);
  }
});

app.get("/api/pdf/:type", async (req, res, next) => {
  try {
    const propertyAddress = clean(req.query.propertyAddress);
    const type = clean(req.params.type);
    if (!propertyAddress) return res.status(400).json({ error: "property_address_required" });
    if (!isPdfType(type)) return res.status(404).json({ error: "pdf_type_not_found" });

    const bundle = await loadPropertyBundle(propertyAddress);
    if (!canGenerateDocument(type, bundle)) return res.status(404).json({ error: "document_data_not_found" });

    const pdfBytes = ["fc1", "fc10", "garantes"].includes(type)
      ? await renderPdfFromDocx(type, bundle)
      : await renderFastPdf(type, bundle);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${type}-${sanitizeFilename(propertyAddress)}.pdf"`);
    res.end(Buffer.from(pdfBytes));
  } catch (error) {
    next(error);
  }
});

app.get("/api/docx/:type", async (req, res, next) => {
  try {
    const propertyAddress = clean(req.query.propertyAddress);
    const type = clean(req.params.type);
    if (!propertyAddress) return res.status(400).json({ error: "property_address_required" });
    if (!["fc1", "fc10", "garantes"].includes(type)) return res.status(404).json({ error: "docx_type_not_found" });

    const bundle = await loadPropertyBundle(propertyAddress);
    if (!canGenerateDocument(type, bundle)) return res.status(404).json({ error: "document_data_not_found" });

    const docxBuffer = await renderDocx(type, bundle);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${type}-${sanitizeFilename(propertyAddress)}.docx"`);
    res.end(docxBuffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/reservations", async (req, res, next) => {
  const data = req.body || {};
  const reservation = data.reservation || data;

  try {
    const payload = normalizeReservation(reservation);
    const missing = requiredFields(payload, [
      "propertyAddress",
      "advisor",
      "tenantTitle",
      "tenantFullName",
      "tenantCuil",
      "tenantDni",
      "tenantMaternalSurname",
      "tenantBirthDate",
      "tenantNationality",
      "tenantOccupation",
      "tenantTaxStatus",
      "currentStreet",
      "currentNumber",
      "currentFloor",
      "currentApartment",
      "currentCity",
      "currentProvince",
      "alternateStreet",
      "alternateNumber",
      "alternateFloor",
      "alternateApartment",
      "alternateCity",
      "alternateProvince",
      "tenantPhone",
      "tenantEmail",
    ]);
    if (missing.length) return res.status(400).json({ error: "missing_required_fields", fields: missing });
    assertValidReservationPayload(payload);

    const { id, deduped } = await withMysqlLock(reservationLockKey(payload), async (connection) => {
      const existing = await findRecentReservationDuplicate(connection, payload);
      if (existing) return { id: existing.id, deduped: true };

      const [result] = await connection.execute(
        `INSERT INTO reservations (
          property_address, advisor, tenant_title, tenant_full_name, tenant_cuil, tenant_dni,
          tenant_maternal_surname, tenant_birth_date, tenant_nationality,
          tenant_occupation, tenant_tax_status, current_street, current_number,
          current_floor, current_apartment, current_city, current_province,
          alternate_street, alternate_number, alternate_floor, alternate_apartment,
          alternate_city, alternate_province, tenant_phone, tenant_email,
          occupants, tenant_count
        ) VALUES (
          :propertyAddress, :advisor, :tenantTitle, :tenantFullName, :tenantCuil, :tenantDni,
          :tenantMaternalSurname, :tenantBirthDate, :tenantNationality,
          :tenantOccupation, :tenantTaxStatus, :currentStreet, :currentNumber,
          :currentFloor, :currentApartment, :currentCity, :currentProvince,
          :alternateStreet, :alternateNumber, :alternateFloor, :alternateApartment,
          :alternateCity, :alternateProvince, :tenantPhone, :tenantEmail,
          :occupants, :tenantCount
        )`,
        payload,
      );

      return { id: result.insertId, deduped: false };
    });

    res.status(deduped ? 200 : 201).json({ id, deduped });
  } catch (error) {
    next(error);
  }
});

app.put("/api/reservations/:id/operation", async (req, res, next) => {
  try {
    const reservation = await findById("reservations", req.params.id);
    if (!reservation) return res.status(404).json({ error: "reservation_not_found" });

    const payload = normalizeOperation(req.body || {}, req.params.id);
    const missing = requiredFields(payload, [
      "reservationDate",
      "reservationAmount",
      "reservationAmountWords",
      "landlordFullName",
      "landlordDni",
    ]);
    if (missing.length) return res.status(400).json({ error: "missing_required_fields", fields: missing });
    assertValidOperationPayload(payload);
    await assertOperationUniqueKeys(payload);

    await pool.execute(
      `INSERT INTO operations (
        reservation_id, receipt_number, reservation_date, reservation_amount,
        reservation_amount_words, reports_amount, reports_amount_words,
        landlord_title, landlord_full_name, landlord_dni, landlord_cuil, landlord_email,
        contract_number, contract_start, contract_end, copy_count
      ) VALUES (
        :reservationId, :receiptNumber, :reservationDate, :reservationAmount,
        :reservationAmountWords, :reportsAmount, :reportsAmountWords,
        :landlordTitle, :landlordFullName, :landlordDni, :landlordCuil, :landlordEmail,
        :contractNumber, :contractStart, :contractEnd, :copyCount
      )
      ON DUPLICATE KEY UPDATE
        receipt_number = VALUES(receipt_number),
        reservation_date = VALUES(reservation_date),
        reservation_amount = VALUES(reservation_amount),
        reservation_amount_words = VALUES(reservation_amount_words),
        reports_amount = VALUES(reports_amount),
        reports_amount_words = VALUES(reports_amount_words),
        landlord_title = VALUES(landlord_title),
        landlord_full_name = VALUES(landlord_full_name),
        landlord_dni = VALUES(landlord_dni),
        landlord_cuil = VALUES(landlord_cuil),
        landlord_email = VALUES(landlord_email),
        contract_number = VALUES(contract_number),
        contract_start = VALUES(contract_start),
        contract_end = VALUES(contract_end),
        copy_count = VALUES(copy_count),
        updated_at = CURRENT_TIMESTAMP`,
      payload,
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/reservations/:id/guarantors", async (req, res, next) => {
  try {
    const reservation = await findById("reservations", req.params.id);
    if (!reservation) return res.status(404).json({ error: "reservation_not_found" });

    const payload = normalizeGuarantor(req.body || {}, req.params.id);
    const missing = requiredFields(payload, ["title", "fullName", "dni", "maternalSurname", "birthDate", "email", "street", "number", "city", "province"]);
    if (missing.length) return res.status(400).json({ error: "missing_required_fields", fields: missing });
    assertValidGuarantorPayload(payload);

    const [result] = await pool.execute(
      `INSERT INTO guarantors (
        reservation_id, title, full_name, dni, maternal_surname, birth_date,
        email, street, number, floor, apartment, city, province
      ) VALUES (
        :reservationId, :title, :fullName, :dni, :maternalSurname, :birthDate,
        :email, :street, :number, :floor, :apartment, :city, :province
      )`,
      payload,
    );

    res.status(201).json({ id: result.insertId });
  } catch (error) {
    next(error);
  }
});

app.post("/api/guarantors", async (req, res, next) => {
  try {
    const payload = normalizePublicGuarantor(req.body || {});
    const missing = requiredFields(payload, [
      "propertyAddress",
      "tenantFullName",
      "relationship",
      "guaranteeType",
      "title",
      "fullName",
      "cuil",
      "dni",
      "maternalSurname",
      "birthDate",
      "maritalStatus",
      "nationality",
      "occupation",
      "phone",
      "email",
      "street",
      "number",
      "floor",
      "apartment",
      "city",
      "province",
    ]);
    if (missing.length) return res.status(400).json({ error: "missing_required_fields", fields: missing });
    assertValidPublicGuarantorPayload(payload);

    const { id, deduped } = await withMysqlLock(guarantorSubmissionLockKey(payload), async (connection) => {
      const existing = await findRecentGuarantorSubmissionDuplicate(connection, payload);
      if (existing) return { id: existing.id, deduped: true };

      const [result] = await connection.execute(
        `INSERT INTO guarantor_submissions (
          property_address, tenant_full_name, relationship, guarantee_type,
          title, full_name, cuil, dni, maternal_surname, birth_date,
          marital_status, nationality, occupation, phone, email,
          street, number, floor, apartment, city, province
        ) VALUES (
          :propertyAddress, :tenantFullName, :relationship, :guaranteeType,
          :title, :fullName, :cuil, :dni, :maternalSurname, :birthDate,
          :maritalStatus, :nationality, :occupation, :phone, :email,
          :street, :number, :floor, :apartment, :city, :province
        )`,
        payload,
      );

      return { id: result.insertId, deduped: false };
    });

    res.status(deduped ? 200 : 201).json({ id, deduped });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);

  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "invalid_json", message: "El pedido esta mal formado." });
  }

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "file_too_large", message: "El archivo supera el limite de 10 MB." });
    }
    return res.status(400).json({ error: "invalid_upload", message: "No se pudo procesar el archivo." });
  }

  if (error.statusCode === 400) {
    return res.status(400).json({ error: error.publicError || "invalid_data", message: "Revisa los datos ingresados." });
  }

  if (error.statusCode === 409) {
    return res.status(409).json({ error: error.publicError || "duplicate_data", message: "El dato ya existe en otra operacion." });
  }

  if (isMysqlDataError(error)) {
    return res.status(400).json({ error: "invalid_data", message: "Revisa los datos ingresados." });
  }

  res.status(500).json({ error: "internal_error", message: "Ocurrio un error interno." });
});

app.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Contratos API listening on port ${port}`);
  if (process.env.OCR_WARMUP === "true") Promise.all([getOcrWorker(), getMrzOcrWorker()]).catch((error) => {
    console.error("[ocr] worker warmup failed:", error?.message || error);
  });
});

async function findById(table, id) {
  const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE id = :id LIMIT 1`, { id });
  return rows[0] || null;
}

async function findOne(table, field, value) {
  const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE ${field} = :value LIMIT 1`, { value });
  return rows[0] || null;
}

async function findMany(table, field, value) {
  const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE ${field} = :value ORDER BY id ASC`, { value });
  return rows;
}

async function withMysqlLock(name, callback) {
  const connection = await pool.getConnection();
  try {
    const [lockRows] = await connection.execute("SELECT GET_LOCK(:name, 5) AS acquired", { name });
    if (Number(lockRows[0]?.acquired) !== 1) throw conflict("request_already_in_progress");
    try {
      return await callback(connection);
    } finally {
      await connection.execute("SELECT RELEASE_LOCK(:name)", { name }).catch((error) => {
        console.error("[mysql-lock] release failed:", error?.message || error);
      });
    }
  } finally {
    connection.release();
  }
}

function reservationLockKey(payload) {
  return mysqlLockKey("reservation", [payload.propertyAddress, payload.tenantDni]);
}

function guarantorSubmissionLockKey(payload) {
  return mysqlLockKey("guarantor", [payload.propertyAddress, payload.dni]);
}

function documentLockKey(payload) {
  return mysqlLockKey("document", [
    payload.propertyAddress,
    payload.actor,
    payload.documentType,
    payload.originalName,
    payload.sizeBytes,
  ]);
}

function mysqlLockKey(prefix, parts) {
  const hash = crypto
    .createHash("sha256")
    .update(parts.map((part) => clean(part).toLocaleLowerCase("es-AR")).join("|"))
    .digest("hex")
    .slice(0, 48);
  return `${prefix}:${hash}`;
}

async function findRecentReservationDuplicate(connection, payload) {
  const [rows] = await connection.execute(
    `SELECT id
     FROM reservations
     WHERE property_address = :propertyAddress
       AND tenant_dni = :tenantDni
       AND created_at >= (NOW() - INTERVAL 10 MINUTE)
     ORDER BY id DESC
     LIMIT 1`,
    payload,
  );
  return rows[0] || null;
}

async function findRecentGuarantorSubmissionDuplicate(connection, payload) {
  const [rows] = await connection.execute(
    `SELECT id
     FROM guarantor_submissions
     WHERE property_address = :propertyAddress
       AND dni = :dni
       AND created_at >= (NOW() - INTERVAL 10 MINUTE)
     ORDER BY id DESC
     LIMIT 1`,
    payload,
  );
  return rows[0] || null;
}

async function findRecentDocumentDuplicate(connection, payload) {
  const [rows] = await connection.execute(
    `SELECT id, property_address, actor, document_type, original_name,
            stored_name, mime_type, size_bytes, created_at
     FROM documents
     WHERE property_address = :propertyAddress
       AND actor = :actor
       AND document_type = :documentType
       AND original_name = :originalName
       AND size_bytes = :sizeBytes
       AND created_at >= (NOW() - INTERVAL 10 MINUTE)
     ORDER BY id DESC
     LIMIT 1`,
    payload,
  );
  return rows[0] || null;
}

async function assertOperationUniqueKeys(payload) {
  if (!payload.receiptNumber && !payload.contractNumber) return;

  const [rows] = await pool.execute(
    `SELECT reservation_id, receipt_number, contract_number
     FROM operations
     WHERE reservation_id <> :reservationId
       AND (
        (:receiptNumber IS NOT NULL AND receipt_number = :receiptNumber)
        OR (:contractNumber IS NOT NULL AND contract_number = :contractNumber)
       )
     LIMIT 1`,
    payload,
  );

  if (!rows.length) return;
  const duplicate = rows[0];
  if (payload.receiptNumber && duplicate.receipt_number === payload.receiptNumber) {
    throw conflict("duplicate_receipt_number");
  }
  if (payload.contractNumber && duplicate.contract_number === payload.contractNumber) {
    throw conflict("duplicate_contract_number");
  }
  throw conflict("duplicate_operation_key");
}

function normalizeReservation(input) {
  return {
    propertyAddress: clip(input.propertyAddress, 255),
    advisor: clip(input.advisor, 80),
    tenantTitle: normalizeOptionalPersonTitle(input.tenantTitle),
    tenantFullName: clip(input.tenantFullName, 180),
    tenantCuil: clipDigits(input.tenantCuil, 30),
    tenantDni: clipDigits(input.tenantDni, 30),
    tenantMaternalSurname: clip(input.tenantMaternalSurname, 120),
    tenantBirthDate: normalizeDate(input.tenantBirthDate),
    tenantNationality: clip(input.tenantNationality, 80),
    tenantOccupation: clip(input.tenantOccupation, 140),
    tenantTaxStatus: clip(input.tenantTaxStatus, 80),
    currentStreet: clip(input.currentStreet, 140),
    currentNumber: clip(input.currentNumber, 40),
    currentFloor: nullableClip(input.currentFloor, 40),
    currentApartment: nullableClip(input.currentApartment, 40),
    currentCity: clip(input.currentCity, 120),
    currentProvince: clip(input.currentProvince, 120),
    alternateStreet: clip(input.alternateStreet, 140),
    alternateNumber: clip(input.alternateNumber, 40),
    alternateFloor: nullableClip(input.alternateFloor, 40),
    alternateApartment: nullableClip(input.alternateApartment, 40),
    alternateCity: clip(input.alternateCity, 120),
    alternateProvince: clip(input.alternateProvince, 120),
    tenantPhone: clip(input.tenantPhone, 80),
    tenantEmail: clip(input.tenantEmail, 180),
    occupants: nullableClip(input.occupants, 255),
    tenantCount: Number(input.tenantCount || 1),
  };
}

function normalizeOperation(input, reservationId) {
  return {
    reservationId,
    receiptNumber: nullableClip(input.receiptNumber, 80),
    reservationDate: normalizeDate(input.reservationDate),
    reservationAmount: input.reservationAmount || null,
    reservationAmountWords: nullableClip(input.reservationAmountWords, 255),
    reportsAmount: input.reportsAmount || null,
    reportsAmountWords: nullableClip(input.reportsAmountWords, 255),
    landlordTitle: normalizePersonTitle(input.landlordTitle),
    landlordFullName: nullableClip(input.landlordFullName, 180),
    landlordDni: nullableDigits(input.landlordDni, 30),
    landlordCuil: nullableDigits(input.landlordCuil, 30),
    landlordEmail: nullableClip(input.landlordEmail, 180),
    contractNumber: nullableClip(input.contractNumber, 80),
    contractStart: normalizeDate(input.contractStart),
    contractEnd: normalizeDate(input.contractEnd),
    copyCount: Number(input.copyCount || 1),
  };
}

function normalizeGuarantor(input, reservationId) {
  return {
    reservationId,
    title: clip(input.title, 20),
    fullName: clip(input.fullName, 180),
    dni: clipDigits(input.dni, 30),
    maternalSurname: clip(input.maternalSurname, 120),
    birthDate: normalizeDate(input.birthDate),
    email: clip(input.email, 180),
    street: clip(input.street, 140),
    number: clip(input.number, 40),
    floor: nullableClip(input.floor, 40),
    apartment: nullableClip(input.apartment, 40),
    city: clip(input.city, 120),
    province: clip(input.province, 120),
  };
}

function normalizePublicGuarantor(input) {
  return {
    propertyAddress: clip(input.propertyAddress, 255),
    tenantFullName: nullableClip(input.tenantFullName, 180),
    relationship: nullableClip(input.relationship, 80),
    guaranteeType: nullableClip(input.guaranteeType, 120),
    title: clip(input.title || "Sr.", 20),
    fullName: clip(input.fullName, 180),
    cuil: nullableDigits(input.cuil, 30),
    dni: clipDigits(input.dni, 30),
    maternalSurname: clip(input.maternalSurname, 120),
    birthDate: normalizeDate(input.birthDate),
    maritalStatus: nullableClip(input.maritalStatus, 80),
    nationality: nullableClip(input.nationality, 80),
    occupation: nullableClip(input.occupation, 140),
    phone: nullableClip(input.phone, 80),
    email: clip(input.email, 180),
    street: clip(input.street, 140),
    number: clip(input.number, 40),
    floor: nullableClip(input.floor, 40),
    apartment: nullableClip(input.apartment, 40),
    city: clip(input.city, 120),
    province: clip(input.province, 120),
  };
}

function groupByProperty(reservations, guarantors, documents = []) {
  const map = new Map();

  for (const row of reservations) {
    const key = propertyKey(row.property_address);
    const entry = ensurePropertyEntry(map, key, row.property_address);
    entry.reservations.push(row);
    if (row.operation_id) {
      entry.operations.push({
        id: row.operation_id,
        reservation_id: row.id,
        receipt_number: row.receipt_number,
        reservation_date: row.reservation_date,
        reservation_amount: row.reservation_amount,
        reservation_amount_words: row.reservation_amount_words,
        reports_amount: row.reports_amount,
        reports_amount_words: row.reports_amount_words,
        landlord_title: row.landlord_title,
        landlord_full_name: row.landlord_full_name,
        landlord_dni: row.landlord_dni,
        landlord_cuil: row.landlord_cuil,
        landlord_email: row.landlord_email,
        contract_number: row.contract_number,
        contract_start: row.contract_start,
        contract_end: row.contract_end,
        copy_count: row.copy_count,
      });
    }
  }

  for (const row of guarantors) {
    const key = propertyKey(row.property_address);
    const entry = ensurePropertyEntry(map, key, row.property_address);
    entry.guarantors.push(row);
  }

  for (const row of documents) {
    const key = propertyKey(row.property_address);
    const entry = ensurePropertyEntry(map, key, row.property_address);
    entry.documents.push(withDocumentUrl(row));
  }

  return Array.from(map.values()).sort((a, b) => {
    const aDate = latestDate(a);
    const bDate = latestDate(b);
    return bDate.localeCompare(aDate);
  });
}

function ensurePropertyEntry(map, key, propertyAddress) {
  if (!map.has(key)) {
    map.set(key, {
      propertyAddress,
      key,
      reservations: [],
      guarantors: [],
      operations: [],
      documents: [],
    });
  }
  return map.get(key);
}

function propertyKey(value) {
  return clean(value).toLocaleLowerCase("es-AR").replace(/\s+/g, " ");
}

function latestDate(entry) {
  const dates = [
    ...entry.reservations.map((item) => item.updated_at || item.created_at || ""),
    ...entry.guarantors.map((item) => item.created_at || ""),
  ].filter(Boolean).map((value) => new Date(value).toISOString());
  return dates.sort().at(-1) || "";
}

async function ensureRuntimeSchema() {
  await ensureUtf8mb4Schema();

  await pool.query(`
    ALTER TABLE operations
      MODIFY landlord_full_name VARCHAR(180) NULL,
      MODIFY landlord_dni VARCHAR(30) NULL
  `).catch(ignoreMissingSchemaObject);

  if (!(await columnExists("operations", "landlord_title"))) {
    await pool.query(`
      ALTER TABLE operations
        ADD COLUMN landlord_title VARCHAR(20) NULL AFTER reports_amount_words
    `).catch(ignoreMissingSchemaObject);
  }

  if (!(await columnExists("reservations", "tenant_title"))) {
    await pool.query(`
      ALTER TABLE reservations
        ADD COLUMN tenant_title VARCHAR(20) NULL AFTER advisor
    `).catch(ignoreMissingSchemaObject);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guarantor_submissions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      property_address VARCHAR(255) NOT NULL,
      tenant_full_name VARCHAR(180) NULL,
      relationship VARCHAR(80) NULL,
      guarantee_type VARCHAR(120) NULL,
      title VARCHAR(20) NOT NULL,
      full_name VARCHAR(180) NOT NULL,
      cuil VARCHAR(30) NULL,
      dni VARCHAR(30) NOT NULL,
      maternal_surname VARCHAR(120) NOT NULL,
      birth_date DATE NULL,
      marital_status VARCHAR(80) NULL,
      nationality VARCHAR(80) NULL,
      occupation VARCHAR(140) NULL,
      phone VARCHAR(80) NULL,
      email VARCHAR(180) NOT NULL,
      street VARCHAR(140) NOT NULL,
      number VARCHAR(40) NOT NULL,
      floor VARCHAR(40) NULL,
      apartment VARCHAR(40) NULL,
      city VARCHAR(120) NOT NULL,
      province VARCHAR(120) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_guarantor_submissions_property (property_address),
      INDEX idx_guarantor_submissions_dni (dni),
      INDEX idx_guarantor_submissions_property_dni (property_address, dni)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await ensureIndex(
    "guarantor_submissions",
    "idx_guarantor_submissions_property_dni",
    "ADD INDEX idx_guarantor_submissions_property_dni (property_address, dni)",
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      property_address VARCHAR(255) NOT NULL,
      actor VARCHAR(40) NOT NULL,
      document_type VARCHAR(80) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      size_bytes BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_documents_property (property_address),
      INDEX idx_documents_actor_type (actor, document_type)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await ensureUtf8mb4Tables();
}

function ignoreMissingSchemaObject(error) {
  if (["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"].includes(error?.code)) return;
  throw error;
}

async function columnExists(tableName, columnName) {
  const [rows] = await pool.query(`
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
  `, [tableName, columnName]);

  return rows.length > 0;
}

async function indexExists(tableName, indexName) {
  const [rows] = await pool.query(`
    SELECT 1
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND INDEX_NAME = ?
    LIMIT 1
  `, [tableName, indexName]);

  return rows.length > 0;
}

async function ensureIndex(tableName, indexName, addClause) {
  if (await indexExists(tableName, indexName)) return;
  await pool.query(`ALTER TABLE ${quoteIdentifier(tableName)} ${addClause}`)
    .catch(ignoreMissingSchemaObject);
}

async function ensureUtf8mb4Schema() {
  await pool.query(`ALTER DATABASE ${quoteIdentifier(process.env.DB_NAME || "contratos_rp")} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

async function ensureUtf8mb4Tables() {
  for (const table of ["reservations", "operations", "guarantors", "guarantor_submissions", "documents"]) {
    await pool.query(`ALTER TABLE ${quoteIdentifier(table)} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      .catch(ignoreMissingSchemaObject);
  }
}

function quoteIdentifier(value) {
  const identifier = String(value || "");
  if (!/^[A-Za-z0-9_$]+$/.test(identifier)) {
    throw new Error(`invalid_mysql_identifier_${identifier}`);
  }
  return `\`${identifier}\``;
}

async function loadPropertyBundle(propertyAddress) {
  const [reservations] = await pool.execute(
    `SELECT * FROM reservations WHERE property_address = :propertyAddress ORDER BY updated_at DESC, id DESC LIMIT 1`,
    { propertyAddress },
  );
  const reservation = reservations[0] || null;
  const operation = reservation ? await findOne("operations", "reservation_id", reservation.id) : null;
  const [guarantors] = await pool.execute(
    `SELECT * FROM guarantor_submissions WHERE property_address = :propertyAddress ORDER BY created_at ASC, id ASC`,
    { propertyAddress },
  );
  const [documents] = await pool.execute(
    `SELECT id, property_address, actor, document_type, original_name, stored_name,
            mime_type, size_bytes, created_at
     FROM documents
     WHERE property_address = :propertyAddress
     ORDER BY id ASC`,
    { propertyAddress },
  );
  return { reservation, operation, guarantors, documents, storageDir };
}

function canGenerateDocument(type, bundle) {
  if (type === "garantes") return Array.isArray(bundle.guarantors) && bundle.guarantors.length > 0;
  if (type === "locatario-dni") return matchingDocuments(bundle, "locatario", "dni").length > 0;
  if (type === "locatario-comprobante") return matchingDocuments(bundle, "locatario", "comprobante_sena").length > 0;
  if (type === "garante-dni") return matchingDocuments(bundle, "garante", "dni").length > 0;
  if (type === "garante-recibos") return matchingDocuments(bundle, "garante", "respaldo_garantia").length > 0;
  return Boolean(bundle.reservation);
}

function isPdfType(type) {
  return ["fc1", "fc10", "garantes", "locatario-dni", "locatario-comprobante", "garante-dni", "garante-recibos"].includes(type);
}

function matchingDocuments(bundle, actor, documentType) {
  return (bundle.documents || []).filter((item) => item.actor === actor && item.document_type === documentType);
}

function withDocumentUrl(row) {
  return {
    ...row,
    url: `/api/documents/${row.id}/download`,
  };
}

function snakeDocument(payload) {
  return {
    property_address: payload.propertyAddress,
    actor: payload.actor,
    document_type: payload.documentType,
    original_name: payload.originalName,
    stored_name: payload.storedName,
    mime_type: payload.mimeType,
    size_bytes: payload.sizeBytes,
  };
}

function sanitizeFilename(value) {
  return clean(value).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "documento";
}

function parseDniText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const dniMatch =
    normalized.match(/\b\d{1,2}\.?\d{3}\.?\d{3}\b/) ||
    normalized.match(/\b\d{7,8}\b/);
  const cuilMatch = normalized.match(/\b\d{2}[-\s]?\d{7,8}[-\s]?\d\b/);
  const birthDateMatch =
    normalized.match(/\b\d{2}\/\d{2}\/\d{4}\b/) ||
    normalized.match(/\b\d{4}-\d{2}-\d{2}\b/);

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const labelledName = findAfterLabel(lines, ["apellido y nombre", "nombre", "name"]);
  const upperName = lines.find((line) => {
    const cleanLine = line.replace(/[^A-ZÁÉÍÓÚÜÑ ]/g, "").trim();
    return cleanLine.length >= 8 && cleanLine.split(/\s+/).length >= 2 && cleanLine === line.trim();
  });

  return {
    fullName: normalizeName(labelledName || upperName || ""),
    dni: dniMatch ? dniMatch[0].replace(/\D/g, "") : "",
    cuil: cuilMatch ? cuilMatch[0].replace(/\D/g, "") : "",
    birthDate: birthDateMatch ? normalizeDateInput(birthDateMatch[0]) : "",
  };
}

function findAfterLabel(lines, labels) {
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index].toLocaleLowerCase("es-AR");
    if (!labels.some((label) => lower.includes(label))) continue;
    const inline = lines[index].split(/[:;]/).slice(1).join(" ").trim();
    if (inline) return inline;
    return lines[index + 1] || "";
  }
  return "";
}

function normalizeName(value) {
  return clean(value)
    .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es-AR")
    .replace(/(^|\s)\S/g, (letter) => letter.toLocaleUpperCase("es-AR"));
}

function normalizeDateInput(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [day, month, year] = value.split("/");
  if (!day || !month || !year) return "";
  return `${year}-${month}-${day}`;
}

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function clip(value, max) {
  return clean(value).slice(0, max);
}

function clipDigits(value, max) {
  return clean(value).replace(/\D/g, "").slice(0, max);
}

function nullableClip(value, max) {
  const clipped = clip(value, max);
  return clipped || null;
}

function nullableDigits(value, max) {
  const clipped = clipDigits(value, max);
  return clipped || null;
}

function normalizePersonTitle(value) {
  const title = clean(value).replace(/\s+/g, " ");
  if (/^sr\.?$/i.test(title)) return "Sr.";
  if (/^sra\.?$/i.test(title)) return "Sra.";
  return title ? clip(title, 20) : "Sr.";
}

function normalizeOptionalPersonTitle(value) {
  const title = clean(value).replace(/\s+/g, " ");
  if (/^sr\.?$/i.test(title)) return "Sr.";
  if (/^sra\.?$/i.test(title)) return "Sra.";
  return title ? clip(title, 20) : null;
}

function normalizeDate(value) {
  const date = clean(value);
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("invalid_date");
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw badRequest("invalid_date");
  }
  return date;
}

function requiredFields(payload, fields) {
  return fields.filter((field) => payload[field] === undefined || payload[field] === null || payload[field] === "");
}

function isMysqlDataError(error) {
  return ["ER_DATA_TOO_LONG", "ER_TRUNCATED_WRONG_VALUE", "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD", "WARN_DATA_TRUNCATED"].includes(error?.code);
}

function badRequest(publicError) {
  const error = new Error(publicError);
  error.statusCode = 400;
  error.publicError = publicError;
  return error;
}

function conflict(publicError) {
  const error = new Error(publicError);
  error.statusCode = 409;
  error.publicError = publicError;
  return error;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function removeUploadedFile(file) {
  const filePath = file?.path || (file?.filename ? path.join(storageDir, file.filename) : "");
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[upload] cleanup failed:", error?.message || error);
    }
  }
}

async function validateUploadedDocumentFile(file) {
  const filePath = file?.path || path.join(storageDir, file.filename);
  const mimeType = String(file.mimetype || "").toLowerCase();
  const extension = path.extname(file.originalname || "").toLowerCase();
  const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  try {
    if (mimeType.startsWith("image/") || imageExtensions.has(extension)) {
      const metadata = await sharp(filePath).metadata();
      if (!metadata.width || !metadata.height) throw new Error("invalid_image_file");
      return;
    }

    if (mimeType === "application/pdf" || extension === ".pdf") {
      const bytes = await fs.promises.readFile(filePath);
      const pdf = await UploadedPdfDocument.load(bytes);
      if (pdf.getPageCount() < 1) throw new Error("pdf_without_pages");
      return;
    }
  } catch {
    await removeUploadedFile(file);
    throw badRequest(mimeType.startsWith("image/") || imageExtensions.has(extension) ? "invalid_image_file" : "invalid_pdf_file");
  }

  await removeUploadedFile(file);
  throw badRequest("unsupported_file_type");
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = import("tesseract.js")
      .then(({ createWorker }) => createWorker("spa+eng"))
      .catch((error) => {
        ocrWorkerPromise = null;
        throw error;
      });
  }
  return ocrWorkerPromise;
}

async function getMrzOcrWorker() {
  if (!mrzOcrWorkerPromise) {
    mrzOcrWorkerPromise = import("tesseract.js")
      .then(({ createWorker }) => createWorker("eng"))
      .catch((error) => {
        mrzOcrWorkerPromise = null;
        throw error;
      });
  }
  return mrzOcrWorkerPromise;
}

function withOcrWorker(task) {
  const run = ocrWorkerQueue.then(async () => task(await getOcrWorker()));
  ocrWorkerQueue = run.catch(() => {});
  return run;
}

function withMrzOcrWorker(task) {
  const run = mrzOcrWorkerQueue.then(async () => task(await getMrzOcrWorker()));
  mrzOcrWorkerQueue = run.catch(() => {});
  return run;
}

async function recognizeDniBarcodes(filePath, deadline) {
  const reader = new MultiFormatReader();
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);

  const candidates = [];
  for (const angle of await rotationAnglesForImage(filePath)) {
    if (remainingMs(deadline) < 300) break;
    try {
      const { data, info } = await sharp(filePath)
        .rotate(angle)
        .resize({ width: 1100, height: 1100, fit: "inside", withoutEnlargement: false })
        .grayscale()
        .normalize()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const source = new RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height);
      const bitmap = new BinaryBitmap(new HybridBinarizer(source));
      const result = reader.decode(bitmap);
      const text = result.getText();
      const analysis = analyzeDniBarcodeText(text);
      candidates.push({
        angle,
        variant: "barcode",
        text,
        fields: analysis.fields,
        confidence: analysis.confidence,
        warnings: analysis.warnings,
        documentType: analysis.documentType,
        source: "barcode",
        score: scoreDniCandidate(analysis.fields, text, "barcode"),
      });
    } catch {
      // Si no se puede decodificar el codigo, seguimos con OCR visual.
    } finally {
      reader.reset();
    }
  }
  return candidates;
}

async function recognizeFastDniMrz(worker, filePath, deadline) {
  const angle = (await mrzAnglesForImage(filePath))[0] || 0;
  let best = { angle, variant: "mrz_fast", text: "", fields: {}, score: 0 };

  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789< ",
  });

  const variants = await buildFastMrzVariants(filePath, angle);
  for (const variant of variants) {
    if (remainingMs(deadline) < 900) break;
    try {
      const result = await withTimeout(
        worker.recognize(variant.image),
        Math.min(5200, Math.max(1000, remainingMs(deadline) - 150)),
        `ocr_mrz_fast_timeout_${angle}_${variant.name}`,
      );
      const text = result.data.text || "";
      if (!looksLikeMrzText(text)) continue;
      const analysis = analyzeDniText(text, "ocr");
      const fields = analysis.fields;
      const score = scoreDniCandidate(fields, text, "ocr") + (/IDARG|I[DP]ARG|<{2,}/i.test(text) ? 45 : 0);
      if (score > best.score) {
        best = {
          angle,
          variant: `mrz_fast_${angle}_${variant.name}`,
          text,
          fields,
          confidence: analysis.confidence,
          warnings: analysis.warnings,
          documentType: analysis.documentType,
          source: "ocr",
          score,
        };
      }
    } catch (error) {
      console.error(`[ocr] fast MRZ variant ${angle}_${variant.name} skipped:`, error?.message || error);
    }
  }

  return best;
}

async function recognizeBestDniMrzCrop(worker, filePath, deadline) {
  const angles = await mrzAnglesForImage(filePath);
  let best = { angle: 0, variant: "mrz_crop", text: "", fields: {}, score: 0 };

  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789< ",
  });

  try {
    for (const angle of angles) {
      if (remainingMs(deadline) < 650) break;
      try {
        const variants = await buildMrzCropVariants(filePath, angle);
        for (const variant of variants) {
          if (remainingMs(deadline) < 650) break;
          const result = await withTimeout(
            worker.recognize(variant.image),
            Math.min(6000, Math.max(1200, remainingMs(deadline) - 150)),
            `ocr_mrz_timeout_${angle}_${variant.name}`,
          );
          const text = result.data.text || "";
          if (!looksLikeMrzText(text)) continue;
          const analysis = analyzeDniText(text, "ocr");
          const fields = analysis.fields;
          const score = scoreDniCandidate(fields, text, "ocr") + (/IDARG|I[DP]ARG|<{2,}/i.test(text) ? 35 : 0);
          if (score > best.score) {
            best = {
              angle,
              variant: `mrz_crop_${angle}_${variant.name}`,
              text,
              fields,
              confidence: analysis.confidence,
              warnings: analysis.warnings,
              documentType: analysis.documentType,
              source: "ocr",
              score,
            };
          }
          if (hasCompleteDniFields(fields)) break;
        }
        if (hasCompleteDniFields(best.fields)) break;
      } catch (error) {
        console.error(`[ocr] MRZ crop ${angle} failed:`, error?.message || error);
      }
    }
  } finally {
    await worker.setParameters({
      tessedit_pageseg_mode: "3",
      tessedit_char_whitelist: "",
    });
  }

  return best;
}

async function mrzAnglesForImage(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const ratio = width ? height / width : 1;
    if (ratio > 1.25) return [270, 90, 0, 180];
    return [0, 270, 90, 180];
  } catch {
    return [0, 270, 90, 180];
  }
}

async function shouldTryMrzCrop(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const ratio = width ? height / width : 1;
    return ratio <= 2.25;
  } catch {
    return true;
  }
}

async function buildFastMrzVariants(filePath, angle) {
  const base = await sharp(filePath)
    .rotate(angle)
    .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  const metadata = await sharp(base).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const top = Math.max(0, Math.round(height * 0.48));

  return [
    {
      name: "bottom52_soft",
      image: await sharp(base).extract({ left: 0, top, width, height: height - top }).png().toBuffer(),
    },
    { name: "full_soft", image: base },
  ];
}

async function buildMrzCropVariants(filePath, angle) {
  const base = await sharp(filePath)
    .rotate(angle)
    .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
  .toBuffer();
  const metadata = await sharp(base).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const specs = [
    { name: "full_soft", topRatio: 0, threshold: 0 },
    { name: "full_threshold", topRatio: 0, threshold: 160 },
    { name: "bottom45_soft", topRatio: 0.55, threshold: 0 },
    { name: "bottom52_soft", topRatio: 0.48, threshold: 0 },
  ];

  const variants = [];
  for (const spec of specs) {
    const top = Math.max(0, Math.round(height * spec.topRatio));
    let image = sharp(base).extract({ left: 0, top, width, height: height - top });
    if (spec.threshold) image = image.threshold(spec.threshold);
    variants.push({ name: spec.name, image: await image.png().toBuffer() });
  }
  return variants;
}

function looksLikeMrzText(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  return /(?:IDARG|I[DP]ARG).{0,20}\d{7,8}|<{2,}.*(?:ARG|\d{6}\d?[MF])/i.test(compact);
}

async function recognizeBestDniImage(worker, filePath, deadline, options = {}) {
  const angles = (await rotationAnglesForImage(filePath)).slice(0, options.maxAngles || Infinity);
  let best = { angle: 0, text: "", fields: {}, score: 0 };

  await worker.setParameters({
    tessedit_pageseg_mode: "3",
    tessedit_char_whitelist: "",
  });

  for (const angle of angles) {
    if (remainingMs(deadline) < 750) break;
    try {
      const variants = await buildOcrVariants(filePath, angle, deadline);
      for (const variant of variants) {
        if (remainingMs(deadline) < 750) break;
        const result = await withTimeout(
          worker.recognize(variant.image),
          Math.min(ocrAttemptTimeoutMs, Math.max(600, remainingMs(deadline) - 150)),
          `ocr_attempt_timeout_${angle}_${variant.name}`,
        );
        const text = result.data.text || "";
        const analysis = analyzeDniText(text, "ocr");
        const fields = analysis.fields;
        const score = scoreDniCandidate(fields, text, "ocr");
        if (score > best.score) {
          best = {
            angle,
            variant: variant.name,
            text,
            fields,
            confidence: analysis.confidence,
            warnings: analysis.warnings,
            documentType: analysis.documentType,
            source: "ocr",
            score,
          };
        }
        if (options.stopWhenIdentity && fields.fullName && validDni(fields.dni)) return best;
        if (hasCompleteDniFields(fields)) return best;
      }
    } catch (error) {
      console.error(`[ocr] rotation ${angle} failed:`, error?.message || error);
    }
  }

  return best;
}

async function rotationAnglesForImage(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const ratio = width ? height / width : 1;
    if (ratio <= 0.85) return [0, 180, 270, 90];
    if (ratio > 1.65) return [270, 90, 0, 180];
    return [270, 90, 0, 180];
  } catch {
    return [0, 90, 270, 180];
  }
}

function mergeDniCandidates(candidates) {
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const mrzRanked = ranked.filter((candidate) => candidate.documentType === "dni_dorso_mrz" || /IDARG|I[DP]ARG|<{2,}/i.test(candidate.text || ""));
  const bestWithDni = mrzRanked.find((candidate) => validDni(candidate.fields?.dni)) || ranked.find((candidate) => validDni(candidate.fields?.dni));
  const bestWithCuil = ranked.find((candidate) => validCuil(candidate.fields?.cuil) && validateArgentineCuil(candidate.fields?.cuil));
  const bestWithBirthDate = selectBestBirthDate(ranked);
  const bestWithNationality = ranked.find((candidate) => candidate.fields?.nationality);
  const bestFullName = selectBestFullName(ranked);
  const primary = bestWithDni || bestWithCuil || ranked[0] || { fields: {} };

  const fields = {
    fullName: bestFullName || clean(primary.fields?.fullName),
    dni: clean(bestWithDni?.fields?.dni) || dniFromCuil(bestWithCuil?.fields?.cuil) || "",
    cuil: clean(bestWithCuil?.fields?.cuil) || clean(primary.fields?.cuil),
    birthDate: clean(bestWithBirthDate?.fields?.birthDate) || clean(primary.fields?.birthDate),
    nationality: clean(bestWithNationality?.fields?.nationality) || clean(primary.fields?.nationality),
  };

  const warnings = [
    ...ranked.flatMap((candidate) => candidate.warnings || []),
    ...conflictWarnings(ranked),
    ...fieldQualityWarnings(fields),
  ];

  return {
    fields,
    confidence: mergeConfidence(ranked, fields),
    warnings: reconcileMergedWarnings(fields, warnings),
    documentType: ranked.find((candidate) => candidate.documentType && candidate.documentType !== "desconocido")?.documentType || "desconocido",
    sources: [...new Set(ranked.map((candidate) => candidate.source).filter(Boolean))],
  };
}

function reconcileMergedWarnings(fields, warnings = []) {
  const unique = [...new Set(warnings.filter(Boolean))];
  if (!fields.cuil || !validateArgentineCuil(fields.cuil)) return unique;

  const discardedCuilWarning = "El CUIL leido no paso la validacion y fue descartado.";
  if (!unique.includes(discardedCuilWarning)) return unique;

  return [
    ...unique.filter((warning) => warning !== discardedCuilWarning),
    "El CUIL impreso no paso la validacion; se uso un CUIL valido obtenido por otra lectura del DNI.",
  ];
}

function selectBestBirthDate(candidates = []) {
  const withBirthDate = candidates.filter((candidate) => clean(candidate.fields?.birthDate));
  return (
    withBirthDate.find((candidate) => /fecha\s+de\s+nacimiento|date\s+of\s+birth|\bbirth\b/i.test(candidate.text || "")) ||
    withBirthDate[0]
  );
}

function selectBestFullName(candidates = []) {
  const nameCandidates = candidates
    .map((candidate) => ({ candidate, fullName: clean(candidate.fields?.fullName) }))
    .filter((item) => item.fullName);
  const reliableNames = nameCandidates
    .filter((item) => reliablePersonName(item.fullName))
    .sort((a, b) => scoreNameCandidate(b) - scoreNameCandidate(a));
  const best = reliableNames[0]?.fullName || "";
  return repairFullNameSurname(best, nameCandidates);
}

function scoreNameCandidate({ candidate, fullName }) {
  const text = String(candidate.text || "");
  let score = 0;
  if (candidate.source === "barcode") score += 120;
  if (/apellido|surname|nombre|name/i.test(text) && !/IDARG|I[DP]ARG|<{2,}/i.test(text)) score += 55;
  if (/IDARG|I[DP]ARG|<{2,}/i.test(text)) score += 30;
  score += Math.min(30, clean(fullName).replace(/\s+/g, "").length);
  score += clean(fullName).split(/\s+/).length * 5;
  if (hasOcrNoiseInName(fullName)) score -= 80;
  if (/\b(?:PAT|SURNAM|SURNAME|SUMAME|SURNARNE)\b/i.test(fullName)) score -= 40;
  return score;
}

function repairFullNameSurname(fullName, nameCandidates = []) {
  const words = clean(fullName).split(/\s+/).filter(Boolean);
  if (words.length < 2) return fullName;

  const currentSurname = words.at(-1);
  const currentGivenNames = foldOcrComparison(words.slice(0, -1).join(" "));
  const betterFullName = nameCandidates
    .map(({ fullName: candidateName }) => clean(candidateName))
    .filter((candidateName) => {
      const candidateWords = candidateName.split(/\s+/).filter(Boolean);
      if (candidateWords.length !== words.length) return false;
      const candidateGivenNames = foldOcrComparison(candidateWords.slice(0, -1).join(" "));
      const candidateSurname = candidateWords.at(-1);
      return candidateGivenNames === currentGivenNames &&
        isNearSurname(candidateSurname, currentSurname) &&
        foldOcrComparison(candidateSurname).length > foldOcrComparison(currentSurname).length;
    })
    .sort((a, b) => foldOcrComparison(b.split(/\s+/).at(-1)).length - foldOcrComparison(a.split(/\s+/).at(-1)).length)[0];
  if (betterFullName) return betterFullName;

  const labelledSingleSurnames = nameCandidates
    .filter(({ candidate, fullName: candidateName }) => {
      const candidateWords = clean(candidateName).split(/\s+/).filter(Boolean);
      return candidateWords.length === 1 && /apellido|surname/i.test(String(candidate.text || ""));
    })
    .map(({ fullName: candidateName }) => candidateName);

  const betterSurname = labelledSingleSurnames.find((surname) => isNearSurname(surname, currentSurname));
  if (!betterSurname) return fullName;
  return [...words.slice(0, -1), betterSurname].join(" ");
}

function isNearSurname(preferred, current) {
  const a = foldOcrComparison(preferred);
  const b = foldOcrComparison(current);
  if (!a || !b || a === b) return false;
  if (b.endsWith(a) && b.length - a.length <= 1) return true;
  if (a.endsWith(b) && a.length - b.length <= 1) return true;
  return levenshteinDistance(a, b) <= 1;
}

function levenshteinDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function foldOcrComparison(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toLocaleLowerCase("es-AR");
}

function assertValidReservationPayload(payload) {
  assertValidDni(payload.tenantDni, "tenant_dni");
  assertValidCuil(payload.tenantCuil, "tenant_cuil");
  assertValidPhone(payload.tenantPhone, "tenant_phone");
  assertValidEmail(payload.tenantEmail, "tenant_email");
  assertPositiveInteger(payload.tenantCount, "tenant_count");
}

function assertValidOperationPayload(payload) {
  assertValidDni(payload.landlordDni, "landlord_dni");
  if (payload.landlordCuil) assertValidCuil(payload.landlordCuil, "landlord_cuil");
  if (payload.landlordEmail) assertValidEmail(payload.landlordEmail, "landlord_email");
  assertNonNegativeNumber(payload.reservationAmount, "reservation_amount");
  if (payload.reportsAmount !== null) assertNonNegativeNumber(payload.reportsAmount, "reports_amount");
  assertPositiveInteger(payload.copyCount, "copy_count");
}

function assertValidGuarantorPayload(payload) {
  assertValidDni(payload.dni, "guarantor_dni");
  assertValidEmail(payload.email, "guarantor_email");
}

function assertValidPublicGuarantorPayload(payload) {
  assertValidGuarantorPayload(payload);
  assertValidCuil(payload.cuil, "guarantor_cuil");
  assertValidPhone(payload.phone, "guarantor_phone");
}

function assertValidDni(value, field) {
  if (!/^\d{7,8}$/.test(clean(value))) throw badRequest(`invalid_${field}`);
}

function assertValidCuil(value, field) {
  if (!validateArgentineCuil(value)) throw badRequest(`invalid_${field}`);
}

function assertValidPhone(value, field) {
  const text = clean(value);
  const digits = text.replace(/\D/g, "");
  if (!/^[0-9+() .-]{6,30}$/.test(text) || digits.length < 6) throw badRequest(`invalid_${field}`);
}

function assertValidEmail(value, field) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value))) throw badRequest(`invalid_${field}`);
}

function assertNonNegativeNumber(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw badRequest(`invalid_${field}`);
}

function assertPositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw badRequest(`invalid_${field}`);
}

async function buildOcrVariants(filePath, angle, deadline) {
  const variants = [];
  if (remainingMs(deadline) < 750) return variants;
  variants.push({
    name: angle === 0 ? "original" : `rotated_${angle}`,
    image: angle === 0 ? filePath : await sharp(filePath).rotate(angle).jpeg({ quality: 88 }).toBuffer(),
  });
  if (remainingMs(deadline) < 3600) return variants;
  const enhanced = await sharp(filePath)
    .rotate(angle)
    .resize({ width: 1300, height: 1300, fit: "inside", withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .jpeg({ quality: 90 })
    .toBuffer();
  variants.push({ name: `enhanced_${angle}`, image: enhanced });
  if (remainingMs(deadline) < 5600) return variants;

  const focusedBase = await sharp(filePath)
    .rotate(angle)
    .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  const metadata = await sharp(focusedBase).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const isLandscape = width >= height;
  const crop = isLandscape
    ? { left: 0, top: Math.round(height * 0.58), width, height: Math.max(1, height - Math.round(height * 0.58)) }
    : { left: 0, top: 0, width: Math.max(1, Math.round(width * 0.42)), height };
  variants.push({
    name: `document_number_focus_${angle}`,
    image: await sharp(focusedBase)
      .extract(crop)
      .resize({ width: 1600, height: 900, fit: "inside", withoutEnlargement: false })
      .threshold(172)
      .png()
      .toBuffer(),
  });
  return variants;
}

async function recognizeWithOcrSpace(){return null;}

function scoreDniCandidate(fields = {}, text = "", source = "ocr") {
  let score = 0;
  if (validDni(fields.dni)) score += 100;
  if (validCuil(fields.cuil) && validateArgentineCuil(fields.cuil)) score += 35;
  if (fields.birthDate) score += 20;
  if (reliablePersonName(fields.fullName)) score += 20;
  if (source === "barcode") score += 80;
  if (/IDARG|<{2,}/i.test(text)) score += 40;
  if (/apellido|surname|nombre|name|documento|dni/i.test(text)) score += 10;
  score += Math.min(20, String(text || "").replace(/\s+/g, " ").trim().length / 60);
  return score;
}

function validDni(value) {
  return /^\d{7,8}$/.test(clean(value));
}

function validCuil(value) {
  return /^\d{11}$/.test(clean(value));
}

function dniFromCuil(value) {
  const digits = clean(value);
  return validCuil(digits) ? digits.slice(2, 10) : "";
}

function reliablePersonName(value) {
  const words = clean(value).split(/\s+/).filter(Boolean);
  return words.length >= 2 &&
    words.every((word) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,}$/.test(word)) &&
    !hasOcrNoiseInName(value);
}

function hasOcrNoiseInName(value) {
  const text = clean(value);
  return /[KLC]{4,}/i.test(text) || /\b(?:ARGENTINA|SURNAM|SURNAME|SUMAME|SURNARNE|LUGAR|NACIMIENTO|NAGIMIENTO|DOMICILIO|PROV|PROVINCIA|HUELLA|DACTILAR|PULGAR)\b/i.test(text);
}

function hasCompleteDniFields(fields = {}) {
  return Boolean(fields.fullName && fields.dni && fields.cuil && fields.birthDate && fields.nationality);
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function conflictWarnings(candidates) {
  const labels = {
    fullName: "nombre",
    dni: "DNI",
    cuil: "CUIL",
    birthDate: "fecha de nacimiento",
    nationality: "nacionalidad",
  };
  return Object.entries(labels).flatMap(([field, label]) => {
    const values = [...new Set(candidates.map((candidate) => clean(candidate.fields?.[field])).filter(Boolean))];
    return values.length > 1 ? [`Hay lecturas distintas para ${label}; se uso la de mayor confianza.`] : [];
  });
}

function fieldQualityWarnings(fields) {
  const warnings = [];
  if (fields.cuil && !validateArgentineCuil(fields.cuil)) warnings.push("El CUIL no paso la validacion.");
  if (fields.birthDate && Number(fields.birthDate.slice(0, 4)) > new Date().getFullYear()) {
    warnings.push("La fecha detectada no parece una fecha de nacimiento valida.");
  }
  return warnings;
}

function mergeConfidence(candidates, fields) {
  const confidence = {};
  for (const field of ["fullName", "dni", "cuil", "birthDate", "nationality"]) {
    const value = clean(fields[field]);
    if (!value) {
      confidence[field] = "";
      continue;
    }
    const source = candidates.find((candidate) => clean(candidate.fields?.[field]) === value)?.source || "";
    confidence[field] = source === "barcode" ? "alta" : "media";
    if (field === "cuil" && validateArgentineCuil(value)) confidence[field] = "alta";
  }
  return confidence;
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const cleanWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000;
  const cleanMax = Number.isFinite(max) ? Math.max(0, max) : 10;

  return (req, res, next) => {
    if (!cleanMax) return next();

    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + cleanWindowMs };
      hits.set(key, bucket);
    }

    if (bucket.count >= cleanMax) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: "too_many_requests", message: "Demasiados pedidos de OCR. Proba de nuevo en unos segundos." });
    }

    bucket.count += 1;
    if (hits.size > 1000) {
      for (const [hitKey, hitBucket] of hits) {
        if (hitBucket.resetAt <= now) hits.delete(hitKey);
      }
    }

    return next();
  };
}

function parseCorsOrigin(value) {
  if (!value) return false;
  if (value === "true" || value === "*") return true;
  return value.split(",").map((origin) => origin.trim()).filter(Boolean);
}
