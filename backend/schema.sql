CREATE DATABASE IF NOT EXISTS portfolio_contracts
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE portfolio_contracts;

CREATE TABLE IF NOT EXISTS reservations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_address VARCHAR(255) NOT NULL,
  advisor VARCHAR(80) NOT NULL,
  tenant_title VARCHAR(20) NULL,
  tenant_full_name VARCHAR(180) NOT NULL,
  tenant_cuil VARCHAR(30) NOT NULL,
  tenant_dni VARCHAR(30) NOT NULL,
  tenant_maternal_surname VARCHAR(120) NOT NULL,
  tenant_birth_date DATE NULL,
  tenant_nationality VARCHAR(80) NOT NULL,
  tenant_occupation VARCHAR(140) NOT NULL,
  tenant_tax_status VARCHAR(80) NOT NULL,
  current_street VARCHAR(140) NOT NULL,
  current_number VARCHAR(40) NOT NULL,
  current_floor VARCHAR(40) NULL,
  current_apartment VARCHAR(40) NULL,
  current_city VARCHAR(120) NOT NULL,
  current_province VARCHAR(120) NOT NULL,
  alternate_street VARCHAR(140) NOT NULL,
  alternate_number VARCHAR(40) NOT NULL,
  alternate_floor VARCHAR(40) NULL,
  alternate_apartment VARCHAR(40) NULL,
  alternate_city VARCHAR(120) NOT NULL,
  alternate_province VARCHAR(120) NOT NULL,
  tenant_phone VARCHAR(80) NOT NULL,
  tenant_email VARCHAR(180) NOT NULL,
  occupants VARCHAR(255) NULL,
  tenant_count INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_reservations_tenant_dni (tenant_dni),
  INDEX idx_reservations_property (property_address)
);

CREATE TABLE IF NOT EXISTS operations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reservation_id BIGINT UNSIGNED NOT NULL,
  receipt_number VARCHAR(80) NULL,
  reservation_date DATE NULL,
  reservation_amount DECIMAL(14, 2) NULL,
  reservation_amount_words VARCHAR(255) NULL,
  reports_amount DECIMAL(14, 2) NULL,
  reports_amount_words VARCHAR(255) NULL,
  landlord_title VARCHAR(20) NULL,
  landlord_full_name VARCHAR(180) NULL,
  landlord_dni VARCHAR(30) NULL,
  landlord_cuil VARCHAR(30) NULL,
  landlord_email VARCHAR(180) NULL,
  contract_number VARCHAR(80) NULL,
  contract_start DATE NULL,
  contract_end DATE NULL,
  copy_count INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_operations_reservation (reservation_id),
  UNIQUE KEY uq_operations_receipt_number (receipt_number),
  UNIQUE KEY uq_operations_contract_number (contract_number),
  CONSTRAINT fk_operations_reservation
    FOREIGN KEY (reservation_id) REFERENCES reservations(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guarantors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reservation_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(20) NOT NULL,
  full_name VARCHAR(180) NOT NULL,
  dni VARCHAR(30) NOT NULL,
  maternal_surname VARCHAR(120) NOT NULL,
  birth_date DATE NULL,
  email VARCHAR(180) NOT NULL,
  street VARCHAR(140) NOT NULL,
  number VARCHAR(40) NOT NULL,
  floor VARCHAR(40) NULL,
  apartment VARCHAR(40) NULL,
  city VARCHAR(120) NOT NULL,
  province VARCHAR(120) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_guarantors_reservation (reservation_id),
  CONSTRAINT fk_guarantors_reservation
    FOREIGN KEY (reservation_id) REFERENCES reservations(id)
    ON DELETE CASCADE
);

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
);

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
);
