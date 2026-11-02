const STORAGE_KEY = "portfolio-contracts-v1";
const OCR_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js";
const RESERVATION_SUCCESS_MESSAGE = "Datos guardados en esta instalacion local.";
const GUARANTOR_SUCCESS_MESSAGE = "¡El formulario ha sido exitosamente completado!";
const API_SAVE_TIMEOUT_MS = 45000;
const API_UPLOAD_TIMEOUT_MS = 120000;

const titles = {
  locatario: ["Pagina del locatario", "Carga de reserva con DNI, comprobante y domicilios separados."],
  garante: ["Pagina del garante", "Carga independiente relacionada por direccion del inmueble."],
  operador: ["Operador / inmobiliaria", "Datos de locatario, garantes y documentos agrupados por propiedad."],
  documentos: ["Documentos", "Previsualizacion de recibos y borrador de garantes."],
};

const FIELD_LIMITS = {
  propertyAddress: 255,
  advisor: 80,
  tenantTitle: 20,
  tenantFullName: 180,
  tenantCuil: 30,
  tenantDni: 30,
  tenantMaternalSurname: 120,
  tenantNationality: 80,
  tenantOccupation: 140,
  tenantTaxStatus: 80,
  currentStreet: 140,
  currentNumber: 40,
  currentFloor: 40,
  currentApartment: 40,
  currentCity: 120,
  currentProvince: 120,
  alternateStreet: 140,
  alternateNumber: 40,
  alternateFloor: 40,
  alternateApartment: 40,
  alternateCity: 120,
  alternateProvince: 120,
  tenantPhone: 80,
  tenantEmail: 180,
  relationship: 80,
  guaranteeType: 120,
  title: 20,
  fullName: 180,
  cuil: 30,
  dni: 30,
  maternalSurname: 120,
  maritalStatus: 80,
  nationality: 80,
  occupation: 140,
  phone: 80,
  email: 180,
  street: 140,
  number: 40,
  floor: 40,
  apartment: 40,
  city: 120,
  province: 120,
  reservationAmountWords: 255,
  reportsAmountWords: 255,
  landlordTitle: 20,
  landlordFullName: 180,
  landlordDni: 30,
  contractNumber: 80,
};

const FIELD_VALIDATION_MESSAGES = {
  tenantCuil: "Ingrese un CUIT/CUIL valido de 11 digitos, con o sin guiones.",
  cuil: "Ingrese un CUIT/CUIL valido de 11 digitos, con o sin guiones.",
  tenantDni: "Ingrese un DNI valido de 7 u 8 digitos, sin puntos ni guiones.",
  dni: "Ingrese un DNI valido de 7 u 8 digitos, sin puntos ni guiones.",
  tenantPhone: "Ingrese un telefono valido.",
  phone: "Ingrese un telefono valido.",
  tenantEmail: "Ingrese un correo electronico valido.",
  email: "Ingrese un correo electronico valido.",
};

const API_ERROR_FIELD_MAP = {
  invalid_tenant_cuil: ["tenantCuil"],
  invalid_tenant_dni: ["tenantDni"],
  invalid_tenant_phone: ["tenantPhone"],
  invalid_tenant_email: ["tenantEmail"],
  invalid_guarantor_cuil: ["cuil"],
  invalid_guarantor_dni: ["dni"],
  invalid_guarantor_phone: ["phone"],
  invalid_guarantor_email: ["email"],
  invalid_cuil: ["tenantCuil", "cuil"],
  invalid_dni: ["tenantDni", "dni"],
  invalid_phone: ["tenantPhone", "phone"],
  invalid_email: ["tenantEmail", "email"],
  invalid_date: ["tenantBirthDate", "birthDate"],
};

const RAW_RESERVATION_FIELDS = [
  ["Direccion del inmueble", "property_address"],
  ["Productor comercial", "advisor"],
  ["Tratamiento", "tenant_title"],
  ["Nombre/s y apellido/s", "tenant_full_name"],
  ["CUIT / CUIL", "tenant_cuil"],
  ["DNI", "tenant_dni"],
  ["Apellido materno", "tenant_maternal_surname"],
  ["Fecha de nacimiento", "tenant_birth_date"],
  ["Nacionalidad", "tenant_nationality"],
  ["Profesion / actividad", "tenant_occupation"],
  ["Condicion fiscal", "tenant_tax_status"],
  ["Domicilio actual - Calle", "current_street"],
  ["Domicilio actual - Numero", "current_number"],
  ["Domicilio actual - Piso", "current_floor"],
  ["Domicilio actual - Departamento", "current_apartment"],
  ["Domicilio actual - Localidad", "current_city"],
  ["Domicilio actual - Provincia", "current_province"],
  ["Domicilio alternativo - Calle", "alternate_street"],
  ["Domicilio alternativo - Numero", "alternate_number"],
  ["Domicilio alternativo - Piso", "alternate_floor"],
  ["Domicilio alternativo - Departamento", "alternate_apartment"],
  ["Domicilio alternativo - Localidad", "alternate_city"],
  ["Domicilio alternativo - Provincia", "alternate_province"],
  ["Telefono celular", "tenant_phone"],
  ["Correo electronico", "tenant_email"],
];

const RAW_GUARANTOR_FIELDS = [
  ["Direccion del inmueble reservado", "property_address"],
  ["Nombre y apellido del inquilino", "tenant_full_name"],
  ["Vinculo con el reservante", "relationship"],
  ["Forma de garantia", "guarantee_type"],
  ["Tratamiento", "title"],
  ["Nombre completo", "full_name"],
  ["CUIT / CUIL", "cuil"],
  ["DNI", "dni"],
  ["Apellido materno", "maternal_surname"],
  ["Fecha de nacimiento", "birth_date"],
  ["Estado civil", "marital_status"],
  ["Nacionalidad", "nationality"],
  ["Profesion / actividad", "occupation"],
  ["Calle", "street"],
  ["Numero", "number"],
  ["Piso", "floor"],
  ["Departamento", "apartment"],
  ["Localidad", "city"],
  ["Provincia", "province"],
  ["Telefono celular", "phone"],
  ["Correo electronico", "email"],
];

const documentRenderers = {
  fc1: renderFc1,
  fc10: renderFc10,
  garantes: renderGuarantorsDraft,
};

let state = loadState();
let properties = [];
let selectedProperty = null;
let apiReservationId = localStorage.getItem(`${STORAGE_KEY}:reservationId`) || "";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const on = (selector, eventName, handler) => {
  const element = $(selector);
  if (element) element.addEventListener(eventName, handler);
};

function createInitialState() {
  return {
    reservation: {},
    guarantor: {},
    operation: {},
    guarantors: [],
    selectedDocument: "fc1",
  };
}

function loadState() {
  try {
    return sanitizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return createInitialState();
  }
}

function sanitizeState(value) {
  const initial = createInitialState();
  const input = value && typeof value === "object" ? value : {};
  return {
    reservation: plainObject(input.reservation) ? input.reservation : initial.reservation,
    guarantor: plainObject(input.guarantor) ? input.guarantor : initial.guarantor,
    operation: plainObject(input.operation) ? input.operation : initial.operation,
    guarantors: Array.isArray(input.guarantors) ? input.guarantors.filter(plainObject) : initial.guarantors,
    selectedDocument: documentRenderers[input.selectedDocument] ? input.selectedDocument : "fc1",
  };
}

function saveState(message = "Guardado local", options = {}) {
  const { render = true } = options;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  setStatus(message);
  if (render) renderAll();
}

function clearPublicFormState(formId) {
  if (formId === "reservationForm") {
    state.reservation = {};
    apiReservationId = "";
    localStorage.removeItem(`${STORAGE_KEY}:reservationId`);
  }
  if (formId === "guarantorForm") state.guarantor = {};
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function setStatus(message) {
  $("#storageStatus").textContent = message;
}

function setFormNotice(selector, message = "", variant = "success") {
  const notice = $(selector);
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle("is-error", variant === "error");
}

function bindPublicFormValidation() {
  publicForms().forEach((form) => {
    form.noValidate = true;
    form.addEventListener("input", (event) => clearFieldError(event.target));
    form.addEventListener("change", (event) => clearFieldError(event.target));
  });
}

function publicForms() {
  return ["#reservationForm", "#guarantorForm"].map((selector) => $(selector)).filter(Boolean);
}

function validatePublicForm(form) {
  clearPublicFieldErrors(form);
  const problems = publicFormProblems(form);
  if (!problems.length) return true;

  markPublicFieldErrors(problems.map((problem) => problem.field));
  showPublicPopup(publicValidationMessage(problems), {
    title: "Datos para revisar",
    variant: "error",
    onClose: () => focusFirstPublicError(problems),
  });
  return false;
}

function publicFormProblems(form) {
  const fields = Array.from(form.elements).filter((field) => field.name && !["button", "submit", "hidden"].includes(field.type));
  return fields.flatMap((field) => {
    field.setCustomValidity("");
    if (field.required && isPublicFieldEmpty(field)) return [{ field, reason: "falta completar" }];
    if (!isPublicFieldEmpty(field) && !field.validity.valid) return [{ field, reason: publicInvalidReason(field) }];
    return [];
  });
}

function isPublicFieldEmpty(field) {
  if (field.type === "file") return !field.files?.length;
  return !String(field.value || "").trim();
}

function publicInvalidReason(field) {
  if (field.validity.typeMismatch) return "tiene un formato invalido";
  if (field.validity.patternMismatch) return field.title || FIELD_VALIDATION_MESSAGES[field.name] || "tiene un formato invalido";
  if (field.validity.rangeUnderflow || field.validity.rangeOverflow) return "tiene un valor fuera de rango";
  if (field.validity.badInput) return "tiene un valor invalido";
  return "debe revisarse";
}

function publicValidationMessage(problems) {
  const lines = problems.map((problem) => `- ${fieldLabel(problem.field)}: ${problem.reason}`);
  return `Hay datos para revisar antes de guardar.\n\n${lines.join("\n")}`;
}

function showPublicApiError(form, error) {
  const fields = fieldsForApiError(form, error);
  markPublicFieldErrors(fields);
  const labels = fields.map(fieldLabel).filter(Boolean);
  const details = labels.length ? `\n\nCampos a revisar:\n- ${labels.join("\n- ")}` : "";
  const problems = fields.map((field) => ({ field }));
  showPublicPopup(`No se pudo guardar el formulario.\n${friendlyApiMessage(error)}.${details}`, {
    title: "No se pudo enviar",
    variant: "error",
    onClose: () => focusFirstPublicError(problems),
  });
}

function fieldsForApiError(form, error) {
  const payload = error?.payload || {};
  let names = [];
  if (payload.error === "missing_required_fields" && Array.isArray(payload.fields)) names = payload.fields;
  else names = API_ERROR_FIELD_MAP[payload.error] || [];

  const fields = names.flatMap((name) => Array.from(form.elements[name] ? [form.elements[name]] : []));
  if (error?.message === "upload_failed" || payload.error === "files_required") {
    fields.push(...Array.from(form.querySelectorAll('input[type="file"][required]')).filter(isPublicFieldEmpty));
  }
  return fields.filter(Boolean);
}

function showPublicPopup(message, options = {}) {
  const { title = "Aviso", variant = "success", onClose } = options;
  const existing = $("#publicPopup");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "publicPopup";
  overlay.className = `public-popup public-popup-${variant}`;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "publicPopupTitle");
  overlay.setAttribute("tabindex", "-1");
  overlay.innerHTML = `
    <div class="public-popup-card" role="document">
      <div class="public-popup-icon" aria-hidden="true">${variant === "error" ? "!" : "OK"}</div>
      <h2 id="publicPopupTitle">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <button class="primary-button public-popup-close" type="button">Entendido</button>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
    if (typeof onClose === "function") onClose();
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector(".public-popup-close")?.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
  overlay.focus({ preventScroll: true });
}

function markPublicFieldErrors(fields) {
  fields.forEach((field) => {
    field.classList.add("field-error");
    field.setAttribute("aria-invalid", "true");
    field.closest("label")?.classList.add("field-error-label");
  });
}

function clearPublicFieldErrors(form) {
  Array.from(form.querySelectorAll(".field-error")).forEach(clearFieldError);
}

function clearFieldError(field) {
  if (!field?.classList?.contains("field-error")) return;
  field.classList.remove("field-error");
  field.removeAttribute("aria-invalid");
  field.closest("label")?.classList.remove("field-error-label");
}

function focusFirstPublicError(problems) {
  const field = problems[0]?.field;
  if (!field) return;
  field.scrollIntoView({ behavior: "smooth", block: "center" });
  if (typeof field.focus === "function") field.focus({ preventScroll: true });
}

function fieldLabel(field) {
  const label = field.closest("label");
  if (!label) return field.name;
  const clone = label.cloneNode(true);
  clone.querySelectorAll("input, select, textarea, button").forEach((element) => element.remove());
  return clone.textContent.replace(/\s+/g, " ").trim() || field.name;
}

function bindFriendlyValidationMessages() {
  Object.entries(FIELD_VALIDATION_MESSAGES).forEach(([name, message]) => {
    $$(`input[name="${name}"]`).forEach((field) => {
      field.addEventListener("invalid", () => {
        updateFriendlyValidationMessage(field, message);
        setStatus(message);
      });
      field.addEventListener("input", () => {
        updateFriendlyValidationMessage(field, message);
      });
      field.addEventListener("blur", () => updateFriendlyValidationMessage(field, message));
    });
  });
}

function bindOperationValidationNotice() {
  const form = $("#operationForm");
  if (!form) return;
  form.addEventListener("invalid", () => {
    const message = "Completa los campos obligatorios marcados antes de guardar la operacion.";
    setStatus(message);
    setFormNotice("#operationSaveNotice", message, "error");
  }, true);
  form.addEventListener("input", () => {
    if (form.checkValidity()) setFormNotice("#operationSaveNotice");
  });
  form.addEventListener("change", () => {
    if (form.checkValidity()) setFormNotice("#operationSaveNotice");
  });
}

function updateFriendlyValidationMessage(field, message) {
  field.setCustomValidity("");
  if (!field.value || field.validity.valid) return;
  if (field.validity.patternMismatch || field.validity.typeMismatch) field.setCustomValidity(message);
}

async function saveReservationToApi(reservation) {
  const response = await fetchWithRetry(apiUrl("/api/reservations"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservation }),
  }, { timeoutMs: API_SAVE_TIMEOUT_MS });
  if (!response.ok) throw await apiError(response, "reservation_save_failed");
  const data = await response.json();
  apiReservationId = String(data.id);
  localStorage.setItem(`${STORAGE_KEY}:reservationId`, apiReservationId);
  return data;
}

async function saveGuarantorToApi(guarantor) {
  const response = await fetchWithRetry(apiUrl("/api/guarantors"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(guarantor),
  }, { timeoutMs: API_SAVE_TIMEOUT_MS });
  if (!response.ok) throw await apiError(response, "guarantor_save_failed");
  return response.json();
}

async function saveOperationToApi(operation) {
  const reservationId = operation.reservationId || apiReservationId;
  if (!reservationId) throw new Error("missing_reservation_id");
  const response = await fetchWithRetry(apiUrl(`/api/reservations/${reservationId}/operation`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(operation),
  }, { timeoutMs: API_SAVE_TIMEOUT_MS });
  if (!response.ok) throw await apiError(response, "operation_save_failed");
  return response.json();
}

async function loadPropertiesFromApi() {
  if (!$("#propertyList")) return [];
  const response = await fetch(apiUrl("/api/properties"));
  if (!response.ok) throw new Error(`properties_load_failed:${response.status}`);
  const selectedKey = selectedProperty?.key;
  properties = expandOperationEntries(await response.json());
  if (selectedKey) selectedProperty = properties.find((item) => item.key === selectedKey) || selectedProperty;
  renderProperties();
  return properties;
}

function apiUrl(path) { return path; }

function bindEvents() {
  applyFieldLimits();
  bindFriendlyValidationMessages();
  bindPublicFormValidation();
  bindOperationValidationNotice();
  rememberOcrDefaultMessages();

  $$(".nav-button").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  $$(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedDocument = button.dataset.document;
      saveState("Documento seleccionado");
    });
  });

  $$(".ocr-button").forEach((button) => {
    button.addEventListener("click", () => runDniOcr(button.dataset.ocrTarget));
  });

  on("#reservationForm", "submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!validatePublicForm(form)) return;
    if (!beginFormSubmit(form, "Guardando reserva...")) return;
    try {
      const reservationFiles = collectReservationFiles(form);
      state.reservation = formToObject(form);
      saveState("Reserva guardada local", { render: false });
      let savedInApi = false;
      try {
        await saveReservationToApi(state.reservation);
        savedInApi = true;
        setStatus(`Reserva API #${apiReservationId}`);
      } catch (error) {
        setStatus("No se pudo guardar la reserva");
        showPublicApiError(form, error);
      }
      if (savedInApi) {
        try {
          await uploadReservationFiles(state.reservation.propertyAddress, reservationFiles);
        } catch (error) {
          setStatus("No se pudieron guardar los archivos de la reserva");
          showPublicApiError(form, error);
          return;
        }
        await loadPropertiesFromApi().catch(() => {});
        finishPublicSubmit("reservationForm", RESERVATION_SUCCESS_MESSAGE);
      }
    } finally {
      endFormSubmit(form);
    }
  });

  on("#guarantorForm", "submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!validatePublicForm(form)) return;
    if (!beginFormSubmit(form, "Guardando garante...")) return;
    try {
      const guarantorFiles = collectGuarantorFiles(form);
      state.guarantor = formToObject(form);
      state.guarantors = upsertLocalGuarantor(state.guarantors, state.guarantor);
      saveState("Garante guardado local", { render: false });
      let savedInApi = false;
      try {
        await saveGuarantorToApi(state.guarantor);
        savedInApi = true;
        setStatus("Garante guardado por propiedad");
      } catch (error) {
        setStatus("No se pudo guardar el garante");
        showPublicApiError(form, error);
      }
      if (savedInApi) {
        try {
          await uploadGuarantorFiles(state.guarantor.propertyAddress, guarantorFiles);
        } catch (error) {
          setStatus("No se pudieron guardar los archivos del garante");
          showPublicApiError(form, error);
          return;
        }
        await loadPropertiesFromApi().catch(() => {});
        finishPublicSubmit("guarantorForm", GUARANTOR_SUCCESS_MESSAGE);
      }
    } finally {
      endFormSubmit(form);
    }
  });

  on("#operationForm", "submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!beginFormSubmit(form, "Guardando operacion...")) return;
    setFormNotice("#operationSaveNotice", "Guardando operacion...");
    try {
      state.operation = formToObject(form);
      saveState("Operacion guardada local");
      try {
        await saveOperationToApi(state.operation);
        setStatus("Operacion guardada en API");
        setFormNotice("#operationSaveNotice", "Operacion guardada correctamente.");
        await loadPropertiesFromApi();
      } catch (error) {
        const message = `La operacion quedo guardada solo en este equipo: ${friendlyApiMessage(error)}.`;
        setStatus(`Operacion local: ${friendlyApiMessage(error)}`);
        setFormNotice("#operationSaveNotice", message, "error");
      }
      renderDocument();
    } finally {
      endFormSubmit(form);
    }
  });

  on("#propertyList", "click", (event) => {
    const button = event.target.closest("[data-property-key]");
    if (!button) return;
    selectedProperty = properties.find((item) => item.key === button.dataset.propertyKey) || null;
    applySelectedProperty();
  });

  on("#propertyDetail", "click", (event) => {
    const button = event.target.closest("[data-raw-source]");
    if (!button) return;
    setRawDataTab(button);
  });

  on("#loadProperties", "click", refreshProperties);
  on("#refreshProperties", "click", refreshProperties);

  on("#printDocument", "click", () => window.print());
  on("#clearData", "click", () => {
    if (!confirm("Limpiar los datos locales de esta demo?")) return;
    state = createInitialState();
    selectedProperty = null;
    apiReservationId = "";
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(`${STORAGE_KEY}:reservationId`);
    renderAll();
    setStatus("Datos locales limpiados");
  });
}

function beginFormSubmit(form, message) {
  if (form.dataset.submitting === "true") return false;
  form.dataset.submitting = "true";
  setStatus(message);
  Array.from(form.querySelectorAll("button[type=\"submit\"]")).forEach((button) => {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = "Guardando...";
  });
  return true;
}

function endFormSubmit(form) {
  form.dataset.submitting = "false";
  Array.from(form.querySelectorAll("button[type=\"submit\"]")).forEach((button) => {
    button.disabled = false;
    button.textContent = button.dataset.originalText || "Guardar";
    delete button.dataset.originalText;
  });
}

function setView(viewName) {
  if (!titles[viewName]) return;
  $$(".nav-button").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewName));
  $$(".view").forEach((view) => view.classList.toggle("is-active", view.id === `view-${viewName}`));
  if ($("#viewTitle")) $("#viewTitle").textContent = titles[viewName][0];
  if ($("#viewSubtitle")) $("#viewSubtitle").textContent = titles[viewName][1];
  if (viewName === "operador") refreshProperties();
}

function finishPublicSubmit(formId, message) {
  const hasInternalPage = Boolean($("#operationForm") || $(".nav-button"));
  if (hasInternalPage) return;
  const form = $(`#${formId}`);
  if (form) form.reset();
  clearPublicFormState(formId);
  resetOcrStatus(formId);
  setStatus("Formulario enviado");
  showPublicPopup(message, { title: "Formulario enviado", variant: "success" });
}

function rememberOcrDefaultMessages() {
  $$("[data-ocr-status]").forEach((item) => {
    if (!item.dataset.defaultText) item.dataset.defaultText = item.textContent;
  });
}

function resetOcrStatus(formId) {
  const status = $(`[data-ocr-status="${formId}"]`);
  if (status) status.textContent = status.dataset.defaultText || "";
}

function resetPublicPageStateOnLoad() {
  const isPublicFormPage = Boolean(($("#reservationForm") || $("#guarantorForm")) && !$("#operationForm") && !$(".nav-button"));
  if (!isPublicFormPage) return;
  state.reservation = {};
  state.guarantor = {};
  state.guarantors = [];
  apiReservationId = "";
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(`${STORAGE_KEY}:reservationId`);
}

async function refreshProperties() {
  const list = $("#propertyList");
  if (!list) return;
  list.innerHTML = '<p class="empty-state">Cargando propiedades...</p>';
  try {
    await loadPropertiesFromApiWithRetry();
    setStatus("Pagina interna actualizada");
  } catch {
    if (state.reservation.propertyAddress) renderPropertiesFromLocal();
    else {
      properties = [];
      list.innerHTML = '<p class="empty-state">No se pudo actualizar. Pulse Actualizar para intentar nuevamente.</p>';
      if ($("#propertyDetail")) $("#propertyDetail").innerHTML = '<p class="empty-state">No hay datos cargados para mostrar.</p>';
      renderPdfActions(null);
    }
    setStatus("Pagina interna sin conexion con la API");
  }
}

async function loadPropertiesFromApiWithRetry(attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await loadPropertiesFromApi();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await waitForRetry(attempt);
    }
  }
  throw lastError || new Error("properties_load_failed");
}

function renderAll() {
  fillForm($("#reservationForm"), state.reservation);
  fillForm($("#guarantorForm"), state.guarantor);
  fillForm($("#operationForm"), state.operation);
  renderDocument();
  renderPdfActions(selectedProperty);
  renderProperties();
}

function renderDocument() {
  if (!$("#documentPreview")) return;
  $$(".tab-button").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.document === state.selectedDocument));
  $("#documentPreview").innerHTML = documentRenderers[state.selectedDocument](state);
}

function renderPropertiesFromLocal() {
  properties = [];
  if (state.reservation.propertyAddress) {
    properties.push({
      key: propertyKey(state.reservation.propertyAddress),
      operationSource: "reservation",
      propertyAddress: state.reservation.propertyAddress,
      reservations: [camelReservationToApiShape(state.reservation)],
      guarantors: state.guarantors.map(camelGuarantorToApiShape),
      operations: state.operation.reservationDate || state.operation.contractNumber ? [camelOperationToApiShape(state.operation)] : [],
    });
  }
  renderProperties();
}

function expandOperationEntries(items = []) {
  const expanded = items.flatMap((item) => {
    const entries = [];
    const reservations = Array.isArray(item.reservations) ? item.reservations : [];
    const guarantors = Array.isArray(item.guarantors) ? item.guarantors : [];
    const operations = Array.isArray(item.operations) ? item.operations : [];
    const documents = Array.isArray(item.documents) ? item.documents : [];
    const baseKey = item.key || propertyKey(item.propertyAddress);

    reservations.forEach((reservation, index) => {
      entries.push({
        ...item,
        key: `${baseKey}:reservation:${reservation.id || index}`,
        operationSource: "reservation",
        reservations: [reservation],
        guarantors,
        operations: operations.filter((operation) => !operation.reservation_id || String(operation.reservation_id) === String(reservation.id)),
        documents,
      });
    });

    if (guarantors.length && !reservations.length) {
      entries.push({
        ...item,
        key: `${baseKey}:guarantors`,
        operationSource: "guarantors",
        reservations: [],
        guarantors,
        operations: [],
        documents,
      });
    }

    if (!entries.length) {
      entries.push({
        ...item,
        key: `${baseKey}:documents`,
        operationSource: "documents",
        reservations,
        guarantors,
        operations,
        documents,
      });
    }

    return entries;
  });
  return mergeOrphanPropertyEntries(expanded);
}

function mergeOrphanPropertyEntries(entries = []) {
  const reservationEntries = entries.filter((entry) => entry.reservations?.length);
  const reservationByAddress = new Map(reservationEntries.map((entry) => [normalizedPropertyKey(entry.propertyAddress), entry]));

  return entries.filter((entry) => {
    if (entry.reservations?.length) return true;
    const matchingReservation = reservationByAddress.get(normalizedPropertyKey(entry.propertyAddress));
    if (!matchingReservation) return true;

    matchingReservation.guarantors = mergeUniqueRows(matchingReservation.guarantors, entry.guarantors);
    matchingReservation.operations = mergeUniqueRows(matchingReservation.operations, entry.operations);
    matchingReservation.documents = mergeUniqueRows(matchingReservation.documents, entry.documents);
    return false;
  });
}

function mergeUniqueRows(primary = [], extra = []) {
  const next = Array.isArray(primary) ? [...primary] : [];
  const seen = new Set(next.map(rowIdentity));
  (Array.isArray(extra) ? extra : []).forEach((row) => {
    const key = rowIdentity(row);
    if (seen.has(key)) return;
    seen.add(key);
    next.push(row);
  });
  return next;
}

function rowIdentity(row = {}) {
  return [
    row.id || "",
    row.stored_name || "",
    row.original_name || "",
    row.full_name || "",
    row.dni || "",
    JSON.stringify(row),
  ].join("|");
}

function operationSourceLabel(source) {
  if (source === "reservation") return "Reserva";
  if (source === "guarantors") return "Garantes";
  return "Archivos";
}

function availableDocumentActions(entry) {
  if (entry?.operationSource === "guarantors") {
    if (!entry.guarantors?.length) return [];
    return [
      { fmt: "pdf", type: "garantes", label: "Garantes · PDF" },
      { fmt: "docx", type: "garantes", label: "Garantes · Word" },
      { fmt: "pdf", type: "garante-dni", label: "DNI garante · PDF" },
      { fmt: "pdf", type: "garante-recibos", label: "Recibos garante · PDF" },
    ];
  }

  if (entry?.operationSource === "reservation" || entry?.reservations?.length) {
    if (!entry.reservations?.length) return [];
    const actions = [
      { fmt: "pdf", type: "fc1", label: "FC1 · PDF" },
      { fmt: "docx", type: "fc1", label: "FC1 · Word" },
      { fmt: "pdf", type: "fc10", label: "FC10 · PDF" },
      { fmt: "docx", type: "fc10", label: "FC10 · Word" },
      { fmt: "pdf", type: "locatario-dni", label: "DNI locatario · PDF" },
      { fmt: "pdf", type: "locatario-comprobante", label: "Comprobante de pago · PDF" },
    ];
    if (entry.guarantors?.length) {
      actions.push(
        { fmt: "pdf", type: "garantes", label: "Garantes · PDF" },
        { fmt: "docx", type: "garantes", label: "Garantes · Word" },
        { fmt: "pdf", type: "garante-dni", label: "DNI garante · PDF" },
        { fmt: "pdf", type: "garante-recibos", label: "Recibos garante · PDF" },
      );
    }
    return actions;
  }

  return [];
}

function renderProperties() {
  const list = $("#propertyList");
  if (!list) return;
  if (!properties.length) {
    list.innerHTML = '<p class="empty-state">Sin propiedades cargadas todavia.</p>';
    if ($("#propertyDetail")) $("#propertyDetail").innerHTML = '<p class="empty-state">Selecciona una propiedad para ver los datos relacionados.</p>';
    renderPdfActions(null);
    return;
  }

  list.innerHTML = properties
    .map((item) => {
      const active = selectedProperty && selectedProperty.key === item.key ? " is-selected" : "";
      const sourceLabel = operationSourceLabel(item.operationSource);
      return `
        <button class="property-card${active}" data-property-key="${escapeHtml(item.key)}" type="button">
          <strong>${escapeHtml(item.propertyAddress)}</strong>
          <em>${escapeHtml(sourceLabel)}</em>
          <span>${item.reservations.length} locatario(s) · ${item.guarantors.length} garante(s) · ${item.operations.length} operacion(es) · ${(item.documents || []).length} archivo(s)</span>
        </button>
      `;
    })
    .join("");

  if (selectedProperty) renderPropertyDetail(selectedProperty);
}

function applySelectedProperty() {
  if (!selectedProperty) return;
  const reservation = selectedProperty.reservations[0] || {};
  const operation = selectedProperty.operations[0] || {};
  state.reservation = apiReservationToCamel(reservation);
  state.operation = apiOperationToCamel(operation, reservation.id);
  state.guarantors = selectedProperty.guarantors.map(apiGuarantorToCamel);
  apiReservationId = reservation.id ? String(reservation.id) : "";
  if (apiReservationId) localStorage.setItem(`${STORAGE_KEY}:reservationId`, apiReservationId);
  else localStorage.removeItem(`${STORAGE_KEY}:reservationId`);
  fillForm($("#operationForm"), state.operation);
  renderPropertyDetail(selectedProperty);
  renderPdfActions(selectedProperty);
  renderProperties();
  renderDocument();
  setStatus(`Propiedad seleccionada: ${selectedProperty.propertyAddress}`);
}

function renderPdfActions(entry) {
  const target = $("#pdfActions");
  if (!target) return;
  if (!entry?.propertyAddress) {
    target.innerHTML = '<p class="empty-state">Selecciona una propiedad para generar los documentos.</p>';
    return;
  }

  const pdfQuery = encodeURIComponent(entry.propertyAddress);
  const docButton = (fmt, type, label) =>
    `<a class="primary-button link-button" href="${apiUrl(`/api/${fmt}/${type}?propertyAddress=${pdfQuery}`)}" target="_blank" rel="noreferrer">${label}</a>`;
  const actions = availableDocumentActions(entry);
  if (!actions.length) {
    target.innerHTML = '<p class="empty-state">No hay documentos disponibles para esta carga.</p>';
    return;
  }

  target.innerHTML = actions.map(({ fmt, type, label }) => docButton(fmt, type, label)).join("");
}

function renderPropertyDetail(entry) {
  if (!$("#propertyDetail")) return;
  const reservation = entry.reservations[0] || {};
  const guarantors = entry.guarantors || [];
  const operation = entry.operations[0] || {};
  const documents = entry.documents || [];
  const landlordTitle = operation.landlord_title || operation.landlordTitle || "";
  const landlordFullName = operation.landlord_full_name || operation.landlordFullName || "";
  const landlordDni = operation.landlord_dni || operation.landlordDni || "";
  const contractNumber = operation.contract_number || operation.contractNumber || "";

  $("#propertyDetail").innerHTML = `
    <section>
      <h3>Locatario</h3>
      ${detailRows([
        ["Tratamiento", reservation.tenant_title],
        ["Nombre", displayName(reservation.tenant_full_name)],
        ["DNI", formatDni(reservation.tenant_dni)],
        ["CUIT/CUIL", formatCuil(reservation.tenant_cuil)],
        ["Email", reservation.tenant_email],
        ["Telefono", reservation.tenant_phone],
      ])}
    </section>
    <section>
      <h3>Garantes</h3>
      ${
        guarantors.length
          ? guarantors
              .map((item) => `<p><strong>${escapeHtml(item.full_name)}</strong><br>DNI ${escapeHtml(item.dni)} · ${escapeHtml(item.email || "sin email")}</p>`)
              .join("")
          : '<p class="empty-state">No hay garantes cargados para esta direccion.</p>'
      }
    </section>
    <section>
      <h3>Operacion</h3>
      ${detailRows([
        ["Fecha de reserva", formatDate(operation.reservation_date)],
        ["Monto de reserva", operation.reservation_amount],
        ["Gastos de informes", operation.reports_amount],
        ["Propietario", [landlordTitle, displayName(landlordFullName)].filter(Boolean).join(" ")],
        ["DNI propietario", formatDni(landlordDni)],
        ["Contrato", contractNumber],
      ])}
    </section>
    <section>
      <h3>Archivos cargados</h3>
      ${
        documents.length
          ? documents
              .map((item) => `<p><strong>${escapeHtml(item.actor)} · ${escapeHtml(item.document_type)}</strong><br><a href="${apiUrl(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.original_name)}</a></p>`)
              .join("")
          : '<p class="empty-state">No hay archivos cargados para esta direccion.</p>'
      }
    </section>
    ${renderRawDataSection(entry)}
  `;
}

function detailRows(rows) {
  return `<dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value || "Pendiente")}</dd>`).join("")}</dl>`;
}

function renderRawDataSection(entry) {
  const rawSources = [
    ...(entry.reservations || []).map((item, index) => ({
      id: `locatario-${index}`,
      label: entry.reservations.length > 1 ? `Locatario ${index + 1}` : "Locatario",
      fields: RAW_RESERVATION_FIELDS,
      item,
    })),
    ...(entry.guarantors || []).map((item, index) => ({
      id: `garante-${index}`,
      label: `Garante ${index + 1}`,
      fields: RAW_GUARANTOR_FIELDS,
      item,
    })),
  ];

  if (!rawSources.length) {
    return `
      <section class="raw-data-section">
        <h3>Datos crudos cargados</h3>
        <p class="empty-state">No hay datos crudos cargados para esta direccion.</p>
      </section>
    `;
  }

  return `
    <section class="raw-data-section">
      <div class="raw-data-heading">
        <div>
          <h3>Datos crudos cargados</h3>
          <p>Campos enviados desde los formularios publicos para esta direccion.</p>
        </div>
        <span>${escapeHtml(entry.propertyAddress || "")}</span>
      </div>
      <div class="raw-data-tabs" role="tablist" aria-label="Datos crudos por formulario">
        ${rawSources
          .map((source, index) => {
            const selected = index === 0 ? "true" : "false";
            return `<button class="tab-button" type="button" role="tab" aria-selected="${selected}" aria-controls="raw-panel-${source.id}" data-raw-source="${source.id}">${escapeHtml(source.label)}</button>`;
          })
          .join("")}
      </div>
      <div class="raw-data-panels">
        ${rawSources
          .map(
            (source, index) => `
              <div class="raw-data-panel" id="raw-panel-${source.id}" role="tabpanel"${index === 0 ? "" : " hidden"}>
                ${renderRawDataTable(source.fields, source.item)}
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderRawDataTable(fields, item) {
  return `
    <div class="raw-data-table-wrap">
      <table class="raw-data-table">
        <thead>
          <tr>
            <th>Campo</th>
            <th>Valor cargado</th>
          </tr>
        </thead>
        <tbody>
          ${fields.map(([label, key]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(rawFieldValue(item?.[key]))}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function rawFieldValue(value) {
  if (value === null || value === undefined || value === "") return "Pendiente";
  if (value instanceof Date) return toDateInput(value);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.split("T")[0] : text;
}

function setRawDataTab(button) {
  const section = button.closest(".raw-data-section");
  if (!section) return;
  section.querySelectorAll("[data-raw-source]").forEach((item) => {
    item.setAttribute("aria-selected", String(item === button));
  });
  section.querySelectorAll(".raw-data-panel").forEach((panel) => {
    panel.hidden = panel.id !== `raw-panel-${button.dataset.rawSource}`;
  });
}

async function runDniOcr(formId) {
  const form = $(`#${formId}`);
  const status = $(`[data-ocr-status="${formId}"]`);
  if (!form || !status) return;
  const frontFile = form.elements.dniFront?.files?.[0];
  const backFile = form.elements.dniBack?.files?.[0];
  if (!frontFile || !backFile) {
    status.textContent = "Subi frente y dorso del DNI para leerlo.";
    return;
  }
  const files = [frontFile, backFile];

  const waitingTimers = [
    setTimeout(() => {
      status.textContent = "Sigo leyendo el DNI. Puede tardar hasta 2 minutos si la foto esta girada o borrosa.";
    }, 15000),
    setTimeout(() => {
      status.textContent = "La lectura sigue en curso. No cierres esta pagina.";
    }, 45000),
    setTimeout(() => {
      status.textContent = "Ultimos intentos de lectura del DNI...";
    }, 85000),
  ];

  try {
    status.textContent = "Leyendo DNI. Puede tardar hasta 2 minutos...";
    clearOcrFields(form);
    const parsed = await readDniWithBackend(files);
    applyOcrResult(form, parsed);
    status.textContent = ocrStatusMessage(parsed, form);
  } catch (error) {
    status.textContent = `${friendlyApiMessage(error)}. Completa los campos manualmente.`;
  } finally {
    waitingTimers.forEach(clearTimeout);
  }
}

async function readDniWithBackend(files) {
  const payload = new FormData();
  files.forEach((file) => payload.append("files", file));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 125000);
  let response;
  try {
    response = await fetch(apiUrl("/api/ocr/dni"), {
      method: "POST",
      body: payload,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("ocr_timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const error = await apiError(response, "ocr_failed");
    error.finalOcrResult = true;
    throw error;
  }
  const data = await response.json();
  const fields = data.fields || {};
  if (!hasUsefulOcrFields(fields)) throw new Error("ocr_empty");
  return {
    ...fields,
    confidence: data.confidence || {},
    warnings: data.warnings || [],
    documentType: data.documentType || "",
    sources: data.sources || [],
  };
}

async function readDniInBrowser(files) {
  await loadTesseract();
  const textParts = [];
  for (const file of files) {
    const result = await Tesseract.recognize(file, "spa+eng");
    textParts.push(result.data.text || "");
  }
  const parsed = parseDniTextV2(textParts.join("\n"));
  if (!hasUsefulOcrFields(parsed)) throw new Error("ocr_empty");
  return parsed;
}

async function loadTesseract() {
  if (window.Tesseract) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = OCR_CDN;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function parseDniText(text) {
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  const dniMatch =
    cleanText.match(/\b\d{1,2}\.?\d{3}\.?\d{3}\b/) ||
    cleanText.match(/\b\d{7,8}\b/);
  const cuilMatch = cleanText.match(/\b\d{2}[-\s]?\d{7,8}[-\s]?\d\b/);
  const birthDateMatch =
    cleanText.match(/\b\d{2}\/\d{2}\/\d{4}\b/) ||
    cleanText.match(/\b\d{4}-\d{2}-\d{2}\b/);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 2 && !/\d{4,}/.test(line));
  const labelledName = findAfterLabel(lines, ["apellido y nombre", "nombre", "name"]);
  const nameLine = labelledName || lines.find((line) => /^[A-ZÁÉÍÓÚÜÑ ]{6,}$/.test(line)) || "";
  return {
    dni: dniMatch ? dniMatch[0].replace(/\D/g, "") : "",
    cuil: cuilMatch ? cuilMatch[0].replace(/\D/g, "") : "",
    birthDate: birthDateMatch ? normalizeOcrDate(birthDateMatch[0]) : "",
    fullName: normalizeOcrName(nameLine),
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

function normalizeOcrName(value) {
  return value
    .toLocaleLowerCase("es-AR")
    .replace(/(^|\s)\S/g, (letter) => letter.toLocaleUpperCase("es-AR"))
    .trim();
}

function parseDniTextV2(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter(Boolean);
  const cleanText = lines.join("\n");
  const surname = findOcrLabelValue(lines, ["apellido", "surname"]);
  const names = findOcrLabelValue(lines, ["nombres", "nombre", "name"], ["apellido"]);
  const labelledName = findOcrLabelValue(lines, ["apellido y nombre", "nombre y apellido"]);
  const nameLine = labelledName || combineOcrName(names, surname) || parseOcrMrzName(lines) || findOcrUppercaseNameLine(lines);
  const dni = extractOcrDni(cleanText);
  const explicitCuil = extractOcrCuil(cleanText);
  const sex = extractOcrSex(cleanText);

  return {
    dni,
    cuil: explicitCuil || calculateOcrCuil(dni, sex),
    birthDate: extractOcrBirthDate(cleanText),
    nationality: extractOcrNationality(cleanText),
    fullName: normalizeOcrNameV2(nameLine),
  };
}

function hasUsefulOcrFields(fields = {}) {
  return Boolean(fields.dni || fields.cuil);
}

function extractOcrDni(text) {
  const labelled = findOcrNearLabels(text, ["dni", "documento", "numero", "número", "number"], /\b\d{1,2}[.\s]?\d{3}[.\s]?\d{3}\b|\b\d{7,8}\b/g);
  if (labelled) return onlyOcrDigits(labelled);
  const mrz = text.match(/\b(?:IDARG|ARG)[A-Z<]*?(\d{7,8})\b/i);
  if (mrz) return onlyOcrDigits(mrz[1]);
  const candidates = [...text.matchAll(/\b\d{1,2}[.\s]?\d{3}[.\s]?\d{3}\b|\b\d{7,8}\b/g)]
    .map((match) => onlyOcrDigits(match[0]))
    .filter((digits) => digits.length >= 7 && digits.length <= 8)
    .filter((digits) => !looksLikeOcrDateDigits(digits));
  return candidates[0] || "";
}

function extractOcrCuil(text) {
  const match = text.match(/\b\d{2}[-\s]?\d{7,8}[-\s]?\d\b/);
  return match ? onlyOcrDigits(match[0]) : "";
}

function extractOcrSex(text) {
  const normalized = foldOcrText(text).replace(/\s+/g, " ");
  const labelled = normalized.match(/\b(?:sexo|sex)\b[^a-zmf]{0,20}\b([mf])\b/i);
  if (labelled) return labelled[1].toUpperCase();
  const compact = stripOcrAccents(text).replace(/\s+/g, "");
  const mrz = compact.match(/\b\d{6}\d?([MF])\d{6}/i);
  return mrz ? mrz[1].toUpperCase() : "";
}

function extractOcrNationality(text) {
  const folded = foldOcrText(text).replace(/\s+/g, " ");
  if (/\b(?:nacionalidad|nationality)\b.{0,60}\b(?:argentina|arg)\b/i.test(folded)) return "Argentina";
  const compact = stripOcrAccents(text).replace(/\s+/g, "");
  if (/\b\d{6}\d?[MF]<*\d{6}[A-Z0-9]?ARG\b/i.test(compact) || /IARG/i.test(compact)) return "Argentina";
  return "";
}

function extractOcrBirthDate(text) {
  const labelled = findOcrNearLabels(text, ["fecha de nacimiento", "nacimiento", "birth", "date of birth"], /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g);
  const direct =
    labelled ||
    text.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/)?.[0] ||
    text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ||
    "";
  return normalizeOcrDate(direct);
}

function findOcrNearLabels(text, labels, pattern) {
  const folded = foldOcrText(text);
  for (const label of labels.map(foldOcrText)) {
    let labelIndex = folded.indexOf(label);
    while (labelIndex !== -1) {
      const windowText = text.slice(labelIndex, labelIndex + 90);
      const match = [...windowText.matchAll(pattern)][0];
      if (match) return match[0];
      labelIndex = folded.indexOf(label, labelIndex + label.length);
    }
  }
  return "";
}

function findOcrLabelValue(lines, labels, excludedLabels = []) {
  const cleanLabels = labels.map(foldOcrText);
  const excluded = excludedLabels.map(foldOcrText);
  for (let index = 0; index < lines.length; index += 1) {
    const foldedLine = foldOcrText(lines[index]);
    if (excluded.some((label) => foldedLine.includes(label))) continue;
    const label = cleanLabels.find((item) => foldedLine.includes(item));
    if (!label) continue;

    const inline = lines[index].slice(foldedLine.indexOf(label) + label.length).replace(/^[:;\-_\s]+/, "").trim();
    if (looksLikeOcrName(inline)) return inline;

    for (const next of lines.slice(index + 1, index + 4)) {
      if (containsOcrLabel(next)) break;
      if (looksLikeOcrName(next)) return next;
    }
  }
  return "";
}

function parseOcrMrzName(lines) {
  const mrzLine = lines.find((line) => /<{2}/.test(line) && /^[A-Z<\s]+$/.test(stripOcrAccents(line).replace(/\s/g, "")));
  if (!mrzLine) return "";
  const clean = stripOcrAccents(mrzLine).replace(/\s+/g, "").replace(/[^A-Z<]/g, "");
  const [surname, names] = clean.split("<<");
  if (!surname || !names) return "";
  return `${names.replace(/</g, " ")} ${surname.replace(/</g, " ")}`;
}

function findOcrUppercaseNameLine(lines) {
  const ignored = /\b(REPUBLICA|ARGENTINA|MERCOSUR|DOCUMENTO|NACIONAL|IDENTIDAD|MINISTERIO|INTERIOR|EJEMPLAR|TRAMITE|FECHA|NACIMIENTO|SEXO|DOMICILIO|NUMERO|APELLIDO|NOMBRES?)\b/i;
  return lines.find((line) => {
    if (ignored.test(stripOcrAccents(line))) return false;
    if (/\d/.test(line)) return false;
    const clean = line.replace(/[^A-ZÁÉÍÓÚÜÑ ]/g, "").trim();
    return clean.length >= 8 && clean.split(/\s+/).length >= 2 && clean === line.trim();
  }) || "";
}

function combineOcrName(names, surname) {
  if (names && surname) return `${names} ${surname}`;
  return names || surname || "";
}

function looksLikeOcrName(value) {
  const text = cleanOcrLine(value);
  if (!text || /\d/.test(text) || containsOcrLabel(text)) return false;
  return text.split(/\s+/).every((word) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,}$/.test(word));
}

function containsOcrLabel(value) {
  const text = foldOcrText(value);
  return ["apellido", "surname", "nombre", "name", "dni", "documento", "numero", "number", "fecha", "birth", "sexo", "domicilio", "nacionalidad"].some((label) => text.includes(label));
}

function looksLikeOcrDateDigits(digits) {
  if (!/^\d{8}$/.test(digits)) return false;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  return year >= 1900 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function normalizeOcrNameV2(value) {
  return cleanOcrLine(value)
    .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es-AR")
    .replace(/(^|\s|-)\S/g, (letter) => letter.toLocaleUpperCase("es-AR"));
}

function calculateOcrCuil(dni, sex) {
  const digits = onlyOcrDigits(dni);
  if (!/^\d{7,8}$/.test(digits)) return "";
  const paddedDni = digits.padStart(8, "0");
  const normalizedSex = String(sex || "").toUpperCase();
  const prefix = normalizedSex === "F" ? "27" : normalizedSex === "M" ? "20" : "";
  if (!prefix) return "";
  const base = `${prefix}${paddedDni}`;
  const multipliers = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = base.split("").reduce((total, digit, index) => total + Number(digit) * multipliers[index], 0);
  const remainder = sum % 11;
  const checkDigit = remainder === 0 ? 0 : remainder === 1 ? 9 : 11 - remainder;
  return `${base}${checkDigit}`;
}

function cleanOcrLine(value) {
  return String(value || "").replace(/[|()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}

function foldOcrText(value) {
  return stripOcrAccents(value).toLocaleLowerCase("es-AR");
}

function stripOcrAccents(value) {
  return String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function onlyOcrDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function ocrFieldsForForm(form) {
  if (form?.id === "guarantorForm") {
    return {
      fullName: form.elements.fullName,
      dni: form.elements.dni,
      cuil: form.elements.cuil,
      birthDate: form.elements.birthDate,
      nationality: form.elements.nationality,
    };
  }
  return {
    fullName: form?.elements.tenantFullName,
    dni: form?.elements.tenantDni,
    cuil: form?.elements.tenantCuil,
    birthDate: form?.elements.tenantBirthDate,
    nationality: form?.elements.tenantNationality,
  };
}

function applyOcrResult(form, parsed) {
  const fields = ocrFieldsForForm(form);
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  fillOcrField(fields.fullName, parsed.fullName, "nombre y apellido", warnings);
  fillOcrField(fields.dni, parsed.dni, "DNI", warnings);
  fillOcrField(fields.cuil, parsed.cuil, "CUIL", warnings);
  fillOcrField(fields.birthDate, parsed.birthDate, "fecha de nacimiento", warnings);
  fillOcrField(fields.nationality, parsed.nationality, "nacionalidad", warnings);
  parsed.warnings = [...new Set(warnings)];
  if (form.id === "reservationForm") state.reservation = formToObject(form);
  if (form.id === "guarantorForm") state.guarantor = formToObject(form);
  saveState("Datos OCR aplicados");
}

function clearOcrFields(form) {
  Object.values(ocrFieldsForForm(form)).forEach((field) => {
    if (field) field.value = "";
  });
  if (form.id === "reservationForm") state.reservation = formToObject(form);
  if (form.id === "guarantorForm") state.guarantor = formToObject(form);
}

function fillOcrField(field, value, label, warnings) {
  if (!field || !value) return;
  const current = String(field.value || "").trim();
  if (!current) {
    field.value = value;
    return;
  }
  if (current !== String(value).trim()) {
    warnings.push(`El campo ${label} ya tenia un valor distinto; no fue reemplazado.`);
  }
}

function ocrStatusMessage(parsed = {}, form) {
  const labels = {
    fullName: "nombre y apellido",
    dni: "DNI",
    cuil: "CUIL",
    birthDate: "fecha de nacimiento",
    nationality: "nacionalidad",
  };
  const keys = Object.keys(labels);
  const fields = ocrFieldsForForm(form);
  const values = {
    fullName: fields.fullName?.value || parsed.fullName,
    dni: fields.dni?.value || parsed.dni,
    cuil: fields.cuil?.value || parsed.cuil,
    birthDate: fields.birthDate?.value || parsed.birthDate,
    nationality: fields.nationality?.value || parsed.nationality,
  };
  const read = keys.filter((key) => values[key]);
  const missing = keys.filter((key) => !values[key]);

  if (!read.length) return appendOcrWarnings("No pude leer ningun dato del DNI. Completa los campos a mano.", parsed);
  if (missing.length) {
    return appendOcrWarnings(`Lei: ${read.map((key) => labels[key]).join(", ")}. No pude leer: ${missing.map((key) => labels[key]).join(", ")}.`, parsed);
  }
  return appendOcrWarnings("DNI leido completo. Revisa los campos antes de guardar.", parsed);
}

function appendOcrWarnings(message, parsed = {}) {
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter(Boolean) : [];
  if (!warnings.length) return message;
  return `${message} Revisar: ${warnings.slice(0, 2).join(" ")}`;
}

function formToObject(form) {
  const data = {};
  for (const element of Array.from(form.elements)) {
    if (!element.name || ["file", "submit", "button"].includes(element.type)) continue;
    data[element.name] = clipField(element.name, element.value);
  }
  return data;
}

function collectReservationFiles(form) {
  return {
    dni: [form.elements.dniFront?.files?.[0], form.elements.dniBack?.files?.[0]].filter(Boolean),
    paymentProof: [form.elements.paymentProof?.files?.[0]].filter(Boolean),
  };
}

function collectGuarantorFiles(form) {
  return {
    dni: [form.elements.dniFront?.files?.[0], form.elements.dniBack?.files?.[0]].filter(Boolean),
    support: Array.from(form.elements.supportFiles?.files || []),
  };
}

async function uploadReservationFiles(propertyAddress, files) {
  await uploadRequiredFiles(propertyAddress, "locatario", "dni", files?.dni || []);
  await uploadRequiredFiles(propertyAddress, "locatario", "comprobante_sena", files?.paymentProof || []);
}

async function uploadGuarantorFiles(propertyAddress, files) {
  await uploadRequiredFiles(propertyAddress, "garante", "dni", files?.dni || []);
  await uploadRequiredFiles(propertyAddress, "garante", "respaldo_garantia", files?.support || []);
}

async function uploadRequiredFiles(propertyAddress, actor, documentType, files) {
  const result = await uploadFiles(propertyAddress, actor, documentType, files);
  if (!result?.documents?.length) throw new Error("upload_failed");
  return result;
}

async function uploadFiles(propertyAddress, actor, documentType, files) {
  const cleanFiles = files.filter(Boolean);
  if (!propertyAddress || !cleanFiles.length) return null;

  const payload = new FormData();
  payload.append("propertyAddress", propertyAddress);
  payload.append("actor", actor);
  payload.append("documentType", documentType);
  cleanFiles.forEach((file) => payload.append("files", file));

  const response = await fetchWithRetry(apiUrl("/api/documents"), {
    method: "POST",
    body: payload,
  }, { attempts: 2, timeoutMs: API_UPLOAD_TIMEOUT_MS });
  if (!response.ok) throw await apiError(response, "upload_failed");
  return response.json();
}

async function fetchWithRetry(url, options = {}, settings = {}) {
  const retryOptions = typeof settings === "number" ? { attempts: settings } : settings;
  const attempts = retryOptions.attempts || 3;
  const timeoutMs = retryOptions.timeoutMs || API_SAVE_TIMEOUT_MS;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!isRetryableStatus(response.status) || attempt === attempts) return response;
      await waitForRetry(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        const networkError = new Error(isAbortError(error) ? "network_request_timeout" : "network_request_failed");
        networkError.cause = error;
        throw networkError;
      }
      await waitForRetry(attempt);
    }
  }
  throw lastError || new Error("network_request_failed");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_SAVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function isRetryableStatus(status) {
  return [408, 429, 502, 503, 504].includes(status);
}

function waitForRetry(attempt) {
  return new Promise((resolve) => setTimeout(resolve, 350 * attempt));
}

function applyFieldLimits() {
  Object.entries(FIELD_LIMITS).forEach(([name, max]) => {
    $$(`[name="${name}"]`).forEach((field) => {
      if (field.tagName === "INPUT" && ["number", "date", "file"].includes(field.type)) return;
      field.maxLength = max;
    });
  });
}

function clipField(name, value) {
  const max = FIELD_LIMITS[name];
  const text = String(value ?? "").trim();
  return max ? text.slice(0, max) : text;
}

function normalizeOcrDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [day, month, year] = value.split("/");
  if (!day || !month || !year) return "";
  return `${year}-${month}-${day}`;
}

async function apiError(response, fallback) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {}
  const error = new Error(payload.error || fallback);
  error.status = response.status;
  error.payload = payload;
  return error;
}

function friendlyApiMessage(error) {
  if (error?.message === "missing_reservation_id") return "selecciona una reserva API para guardar";
  if (error?.message === "upload_failed") return "no se pudieron guardar los archivos obligatorios";
  if (error?.message === "network_request_timeout") return "la API tardo demasiado en responder; revise la conexion e intente nuevamente";
  if (error?.message === "network_request_failed") return "no se pudo conectar con la API; intente guardar nuevamente";
  if (error?.message === "dni_read_incomplete") return "la lectura del DNI no fue confiable";
  if (error?.message === "dni_not_readable") return "no se pudo leer el DNI";
  if (error?.message === "ocr_timeout") return "la lectura del DNI demoro demasiado";
  if (error?.message === "ocr_empty") return "no se detectaron datos utiles en el DNI";
  if (error?.payload?.error === "files_required") return "adjunta los archivos obligatorios antes de guardar";
  if (error?.payload?.error === "unsupported_file_type") return "uno de los archivos tiene un formato no admitido";
  if (error?.payload?.error === "invalid_image_file") return "una de las imagenes no pudo procesarse";
  if (error?.payload?.error === "invalid_pdf_file") return "uno de los PDF no pudo procesarse";
  if (error?.payload?.error === "invalid_tenant_cuil") return "el CUIT/CUIL del locatario no es valido";
  if (error?.payload?.error === "invalid_tenant_dni") return "el DNI del locatario debe tener 7 u 8 digitos";
  if (error?.payload?.error === "invalid_cuil" || error?.payload?.error === "invalid_guarantor_cuil") return "el CUIT/CUIL ingresado no es valido";
  if (error?.payload?.error === "invalid_dni" || error?.payload?.error === "invalid_guarantor_dni") return "el DNI ingresado debe tener 7 u 8 digitos";
  if (["invalid_phone", "invalid_tenant_phone", "invalid_guarantor_phone"].includes(error?.payload?.error)) return "el telefono ingresado no es valido";
  if (["invalid_email", "invalid_tenant_email", "invalid_guarantor_email"].includes(error?.payload?.error)) return "el correo electronico ingresado no es valido";
  if (error?.payload?.error === "invalid_date") return "una fecha ingresada no es valida";
  if (error?.status === 400) return "hay datos para revisar antes de guardar";
  if (error?.status === 413) return "uno de los archivos supera 10 MB";
  if (error?.status >= 500) return "la API tuvo un error interno";
  return "API no disponible";
}

function fillForm(form, data) {
  if (!form) return;
  Object.entries(data || {}).forEach(([key, value]) => {
    const field = form.elements[key] || document.getElementById(key);
    if (field && field.type !== "file") field.value = value ?? "";
  });
}

function upsertLocalGuarantor(list, guarantor) {
  const next = list.filter((item) => item.dni !== guarantor.dni || item.propertyAddress !== guarantor.propertyAddress);
  next.push(guarantor);
  return next;
}



function renderFc1(){return documentTemplateNotice();}

function renderFc10(){return documentTemplateNotice();}



function renderGuarantorsDraft(){return documentTemplateNotice();}







function cleanPersonTitle(value) {
  const title = cleanText(value).replace(/\s+/g, " ");
  if (/^sr\.?$/i.test(title)) return "Sr.";
  if (/^sra\.?$/i.test(title)) return "Sra.";
  return "";
}

function address(prefix, source = {}) {
  const floor = source[`${prefix}Floor`] ? `, piso: ${source[`${prefix}Floor`]}` : "";
  const apartment = source[`${prefix}Apartment`] ? `, dpto.: ${source[`${prefix}Apartment`]}` : "";
  const street = streetName(source[`${prefix}Street`]);
  const number = source[`${prefix}Number`] || "";
  const city = source[`${prefix}City`] || "";
  const province = source[`${prefix}Province`] || "";
  return `${street} N° ${number}${floor}${apartment}, de la ciudad de ${city}, provincia de ${province}`.trim();
}

function streetName(value) {
  return cleanText(value).replace(/^(calle|avenida|av\.?)\s+/i, "");
}

function displayName(value) {
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const surnameStart = words.length >= 4 ? words.length - 2 : words.length - 1;
  return words
    .map((word, index) => (index >= surnameStart ? word.toLocaleUpperCase("es-AR") : word))
    .join(" ");
}

function formatDni(value) {
  const text = cleanText(value);
  const digits = text.replace(/\D/g, "");
  if (!/^\d{7,8}$/.test(digits)) return text;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatCuil(value) {
  const text = cleanText(value);
  const digits = text.replace(/\D/g, "");
  if (!/^\d{11}$/.test(digits)) return text;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function required(value, fallback) {
  return value && String(value).trim() ? escapeHtml(value) : `<span class="placeholder">${escapeHtml(fallback)}</span>`;
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = String(value).split("T")[0].split("-");
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

function longDate(value) {
  if (!value) return "";
  const date = new Date(`${String(value).split("T")[0]}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });
}

function apiReservationToCamel(row = {}) {
  return {
    propertyAddress: row.property_address || "",
    advisor: row.advisor || "",
    tenantTitle: row.tenant_title || "",
    tenantFullName: row.tenant_full_name || "",
    tenantCuil: row.tenant_cuil || "",
    tenantDni: row.tenant_dni || "",
    tenantMaternalSurname: row.tenant_maternal_surname || "",
    tenantBirthDate: toDateInput(row.tenant_birth_date),
    tenantNationality: row.tenant_nationality || "",
    tenantOccupation: row.tenant_occupation || "",
    tenantTaxStatus: row.tenant_tax_status || "",
    currentStreet: row.current_street || "",
    currentNumber: row.current_number || "",
    currentFloor: row.current_floor || "",
    currentApartment: row.current_apartment || "",
    currentCity: row.current_city || "",
    currentProvince: row.current_province || "",
    alternateStreet: row.alternate_street || "",
    alternateNumber: row.alternate_number || "",
    alternateFloor: row.alternate_floor || "",
    alternateApartment: row.alternate_apartment || "",
    alternateCity: row.alternate_city || "",
    alternateProvince: row.alternate_province || "",
    tenantPhone: row.tenant_phone || "",
    tenantEmail: row.tenant_email || "",
  };
}

function apiOperationToCamel(row = {}, reservationId = "") {
  return {
    reservationId: reservationId || row.reservation_id || "",
    propertyAddress: selectedProperty?.propertyAddress || "",
    reservationDate: toDateInput(row.reservation_date),
    reservationAmount: row.reservation_amount || "",
    reservationAmountWords: row.reservation_amount_words || "",
    reportsAmount: row.reports_amount || "",
    reportsAmountWords: row.reports_amount_words || "",
    landlordTitle: row.landlord_title || row.landlordTitle || "",
    landlordFullName: row.landlord_full_name || row.landlordFullName || "",
    landlordDni: row.landlord_dni || row.landlordDni || "",
    contractNumber: row.contract_number || row.contractNumber || "",
  };
}

function apiGuarantorToCamel(row = {}) {
  return {
    propertyAddress: row.property_address || "",
    tenantFullName: row.tenant_full_name || "",
    relationship: row.relationship || "",
    guaranteeType: row.guarantee_type || "",
    title: row.title || "",
    fullName: row.full_name || "",
    cuil: row.cuil || "",
    dni: row.dni || "",
    maternalSurname: row.maternal_surname || "",
    birthDate: toDateInput(row.birth_date),
    maritalStatus: row.marital_status || "",
    nationality: row.nationality || "",
    occupation: row.occupation || "",
    phone: row.phone || "",
    email: row.email || "",
    street: row.street || "",
    number: row.number || "",
    floor: row.floor || "",
    apartment: row.apartment || "",
    city: row.city || "",
    province: row.province || "",
  };
}

function camelReservationToApiShape(item = {}) {
  return {
    id: apiReservationId,
    property_address: item.propertyAddress,
    tenant_title: item.tenantTitle,
    tenant_full_name: item.tenantFullName,
    tenant_dni: item.tenantDni,
    tenant_cuil: item.tenantCuil,
    tenant_email: item.tenantEmail,
    tenant_phone: item.tenantPhone,
  };
}

function camelGuarantorToApiShape(item = {}) {
  return {
    property_address: item.propertyAddress,
    tenant_full_name: item.tenantFullName,
    relationship: item.relationship,
    guarantee_type: item.guaranteeType,
    title: item.title,
    full_name: item.fullName,
    cuil: item.cuil,
    dni: item.dni,
    maternal_surname: item.maternalSurname,
    birth_date: item.birthDate,
    marital_status: item.maritalStatus,
    nationality: item.nationality,
    occupation: item.occupation,
    phone: item.phone,
    email: item.email,
    street: item.street,
    number: item.number,
    floor: item.floor,
    apartment: item.apartment,
    city: item.city,
    province: item.province,
  };
}

function camelOperationToApiShape(item = {}) {
  return {
    reservation_date: item.reservationDate,
    reservation_amount: item.reservationAmount,
    reservation_amount_words: item.reservationAmountWords,
    reports_amount: item.reportsAmount,
    reports_amount_words: item.reportsAmountWords,
    landlord_title: item.landlordTitle,
    landlord_full_name: item.landlordFullName,
    landlord_dni: item.landlordDni,
    contract_number: item.contractNumber,
  };
}

function toDateInput(value) {
  return value ? String(value).split("T")[0] : "";
}

function propertyKey(value) {
  return String(value || "").trim().toLocaleLowerCase("es-AR").replace(/\s+/g, " ");
}

function normalizedPropertyKey(value) {
  return propertyKey(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

resetPublicPageStateOnLoad();
bindEvents();
renderAll();
refreshProperties();

function documentTemplateNotice(){return "<p>Las plantillas privadas no se distribuyen. Configure un generador propio para habilitar esta funcion.</p>";}
