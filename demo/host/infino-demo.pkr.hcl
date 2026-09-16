# The demo host image: the one machine that serves the side-by-side demo.
#
# It is an IMAGE rather than a machine somebody configures, for the reason the
# pipeline's GPU host is:
#
#   "A hand-patched host is a machine nothing in the repository can rebuild,
#    which is the situation this directory exists to end."
#
# The demo host spent weeks as exactly that — processes started by hand under
# nohup, a git bundle copied into place, corpora that existed on one laptop —
# and the cost was not abstract. Two of its three corpora were simply absent, so
# the page said "Checkout or index not on this host" and nobody could tell
# whether that was a bug or a machine nobody had finished. A reboot to change
# the host's service account took the demo down with no unit to bring it back.
# And it could not be cycled, rebuilt, or handed to a colleague, because nothing
# described it.
#
# Everything the host runs is baked in. NOTHING is fetched at boot, and that is
# a consequence rather than a preference: the finished host is launched with NO
# SERVICE ACCOUNT, so it cannot read the bucket the job-postings corpus comes
# from. That corpus is therefore converted during the bake, when the build VM
# does have an identity — the same trade the GPU host makes, for the same
# reason.
#
# What is NOT baked: every secret. The model keys and the platform key arrive at
# launch in /etc/infino/demo.env, which launch-host.sh writes from the operator's
# own copy. An image is a thing you share; a key is not.
#
# Build:
#   packer init .
#   packer build \
#     -var project_id=<proj> \
#     -var jobs_shards=gs://<bucket>/<cust>/<db>/_source/jobs \
#     -var cx_ref=<branch or sha of this repo> \
#     -var image_version=<short sha> \
#     -var network=infino-vpc -var subnetwork=infino-subnet \
#     infino-demo.pkr.hcl

packer {
  required_plugins {
    googlecompute = {
      source  = "github.com/hashicorp/googlecompute"
      version = ">= 1.1.0"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP project the temporary build VM runs in and the baked image is stored in."
}

variable "zone" {
  type        = string
  description = "Zone the build VM runs in. A GCE image is global, so this constrains only the bake."
  default     = "us-east1-b"
}

variable "machine_type" {
  type        = string
  description = "Machine type used to BAKE. Bigger than the demo needs to run on: the bake converts ten Parquet shards into ~880,000 JSON lines, which is the long pole."
  default     = "e2-standard-8"
}

variable "source_image_family" {
  type        = string
  description = "Base image family. Ubuntu LTS: the demo is a node process and needs nothing exotic."
  default     = "ubuntu-2404-lts-amd64"
}

variable "source_image_project" {
  type        = string
  default     = "ubuntu-os-cloud"
  description = "Project publishing the base image."
}

variable "image_version" {
  type        = string
  description = "Version suffix in the image name and the infino_version label, so an image says which source built it. A short commit sha is the intended value. GCE label values admit lowercase letters, digits, underscores and dashes only."
}

variable "git_sha" {
  type        = string
  description = "Full git sha of the checkout that baked this, recorded as infino_built_from."
  default     = ""
}

variable "cx_repo" {
  type        = string
  description = "The repository holding the demo. Cloned into the image so the host carries the demo it serves rather than receiving it later."
  default     = "https://github.com/infino-ai/code-context.git"
}

variable "cx_ref" {
  type        = string
  description = "Branch or sha of `cx_repo` to bake. The demo lives on a branch until it lands, so this is required rather than defaulted to main — an image that silently baked the wrong branch is worse than one that refuses."
}

variable "jobs_shards" {
  type        = string
  description = "gs:// prefix holding the ten Parquet shards of the job-postings corpus — the same bytes the hosted table was hydrated from. Converted to NDJSON during the bake because the finished host has no identity with which to read them."
}

variable "infino_ref" {
  type        = string
  description = "The engine commit the infino corpus is a checkout of. The recorded comparison was measured on it."
  default     = "ed4e020"
}

variable "opensearch_ref" {
  type        = string
  description = "The OpenSearch commit the corpus is a checkout of. A few days' drift changes nothing about which files hold a subsystem, so a fallback to the tip is reported rather than fatal."
  default     = "c72faae5"
}

variable "network" {
  type        = string
  description = "VPC for the build VM. A provisioned environment has no `default` network, so pass its VPC."
  default     = ""
}

variable "subnetwork" {
  type        = string
  description = "Subnetwork for the build VM. Its VPC needs Cloud NAT: this bake clones from GitHub and installs packages, and the build VM takes no external address."
  default     = ""
}

variable "ssh_username" {
  type    = string
  default = "packer"
}

variable "build_service_account_email" {
  type        = string
  description = "Service account the temporary BUILD VM runs as. It needs to read `jobs_shards`; the finished host runs with no service account at all. Empty falls back to the project's default compute SA, which requires the caller to hold serviceAccountUser on it."
  default     = ""
}

variable "impersonate_service_account" {
  type        = string
  description = "Service account to impersonate for the bake. Empty runs as the caller. Impersonation RAISES credentials that are too weak and does not sanitise strong ones — a deployer SA that lacks iam.serviceAccountUser will fail at instance creation where the caller's own identity would have succeeded."
  default     = ""
}

variable "image_family" {
  type        = string
  default     = "infino-demo-host"
}

variable "disk_size_gb" {
  type        = number
  description = "Boot disk of the build VM, and so of the image. The job-postings corpus alone is ~7 GB as NDJSON, and OpenSearch another gigabyte; sized so a bake fails on a number here rather than on a full disk two thirds of the way through a conversion."
  default     = 60
}

variable "manifest_path" {
  type        = string
  description = "Where the manifest post-processor writes the built image's name, for build-image.sh to read back."
  default     = "/tmp/infino-demo-manifest.json"
}

locals {
  build_timestamp = formatdate("YYYYMMDD-hhmmss", timestamp())
  image_name      = "${var.image_family}-${var.image_version}-${local.build_timestamp}"
  staging_dir     = "/tmp/infino-demo-host"
}

source "googlecompute" "demo_host" {
  project_id   = var.project_id
  zone         = var.zone
  machine_type = var.machine_type
  ssh_username = var.ssh_username

  impersonate_service_account = var.impersonate_service_account
  service_account_email       = var.build_service_account_email
  # The build VM reads the corpus bucket; the finished host reads nothing.
  scopes = ["https://www.googleapis.com/auth/cloud-platform"]

  source_image_family     = var.source_image_family
  source_image_project_id = [var.source_image_project]

  disk_size = var.disk_size_gb
  disk_type = "pd-balanced"

  # No external address on the build VM: SSH arrives over an IAP tunnel and the
  # egress for packages and clones comes from the VPC's Cloud NAT.
  use_iap          = true
  omit_external_ip = true
  use_internal_ip  = true

  network    = var.network
  subnetwork = var.subnetwork

  ssh_timeout = "15m"

  image_name        = local.image_name
  image_family      = var.image_family
  image_description = "The Infino side-by-side demo host: the demo, its three corpora, and the units that run them. Launch with NO service account; secrets arrive in /etc/infino/demo.env."

  image_labels = {
    infino_role       = "demo-host"
    infino_version    = var.image_version
    infino_built_from = var.git_sha
  }

  labels = {
    infino_role = "demo-host-bake"
  }
}

build {
  name    = "infino-demo-host"
  sources = ["source.googlecompute.demo_host"]

  provisioner "shell" {
    inline = ["mkdir -p ${local.staging_dir}"]
  }

  provisioner "file" {
    source      = "${path.root}/files/"
    destination = "${local.staging_dir}/"
  }

  # Everything the host runs, installed and enabled but not started: a host
  # launched from this image comes up serving.
  provisioner "shell" {
    execute_command = "sudo -E env CX_REPO='${var.cx_repo}' CX_REF='${var.cx_ref}' JOBS_SHARDS='${var.jobs_shards}' INFINO_REF='${var.infino_ref}' OPENSEARCH_REF='${var.opensearch_ref}' bash '{{ .Path }}'"
    script          = "${path.root}/files/provision.sh"
  }

  post-processor "manifest" {
    output     = var.manifest_path
    strip_path = true
  }
}
