---
title: Linear Algebra and Matrix Theory
aliases:
  - Vector Spaces
  - Matrix Algebra
tags:
  - math
  - linear-algebra
  - operators
created: 2026-01-12
difficulty: intermediate
---

# Linear Algebra

Linear algebra is the branch of mathematics concerning linear equations, linear functions, and their representations through matrices and vector spaces.

## Vector Spaces and Inner Products

A vector space $V$ over a scalar field $\mathbb{F}$ (such as $\mathbb{R}$ or $\mathbb{C}$) is endowed with vector addition and scalar multiplication satisfying the vector space axioms. An inner product space defines geometric lengths and angles:

$$
\langle \mathbf{u}, \mathbf{v} \rangle = \sum_{k=1}^n u_k^* v_k
$$

## Matrices and Transformations

A linear transformation $T: V \to W$ between finite-dimensional spaces can be represented as an $m \times n$ matrix $\mathbf{A} \in \mathbb{F}^{m \times n}$:

$$
\mathbf{M} = \begin{pmatrix} a & b \\ c & d \end{pmatrix}, \quad \det(\mathbf{M}) = ad - bc
$$

The matrix inverse exists if and only if $\det(\mathbf{M}) \neq 0$:

$$
\mathbf{M}^{-1} = \frac{1}{ad - bc} \begin{pmatrix} d & -b \\ -c & a \end{pmatrix}
$$

## Eigenvalues and Eigenvectors

The spectral equation identifies invariant directions of linear operators:

$$
\mathbf{A}\mathbf{v} = \lambda \mathbf{v}
$$ ^matrix-eigen

This relation forms the backbone of quantum mechanical observables where Hermitian operators represent physical observables, connecting directly to [[Physics/Quantum/Schrodinger|Schrödinger wave mechanics]].
